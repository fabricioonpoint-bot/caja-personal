-- Perfiles de usuario y hoja "Registro de usuarios".
-- 1) Corrige _copiar_plantilla: con 'personal' insertaba la misma fila dos veces (error 21000),
--    así que el registro con uso no aplicaba plantillas y aplicar_plantilla('personal') fallaba.
-- 2) perfiles: nombre, edad, teléfono, correo, usos y consentimiento de datos (nunca contraseñas).
--    Se llena al registrarse (trigger en auth.users) y la web puede completarlo o editarlo.
-- 3) registro_usuarios / registro_guardar: la hoja del administrador lee todos los perfiles con sus
--    números y devuelve lo que se corrigió en la hoja (nombre, edad, teléfono). Clave propia (clave_registro).

create or replace function public._copiar_plantilla(p_uid uuid, p_plantilla text)
returns integer language plpgsql security definer set search_path to '' as $function$
declare v_n integer;
begin
  if p_plantilla not in ('taxista','obra','vendedor','personal') then
    raise exception 'Plantilla no válida: %', p_plantilla;
  end if;
  insert into public.plantillas_usuario (user_id, plantilla)
  select distinct p_uid, x from unnest(array[p_plantilla, 'personal']) as x
  on conflict (user_id, plantilla) do update set activa = true;
  insert into public.categorias (user_id, tipo, nombre, ambito, movimiento, subcategorias, tipo_gasto, orden)
  select distinct on (c.tipo, c.categoria) p_uid, c.tipo, c.categoria, c.ambito, c.movimiento, c.subcategorias, c.tipo_gasto, c.orden
    from public.plantillas_catalogo c
   where c.plantilla in (p_plantilla, 'personal')
   order by c.tipo, c.categoria, (c.plantilla = 'personal'), c.orden
  on conflict (user_id, tipo, nombre) do update
    set ambito = coalesce(public.categorias.ambito, excluded.ambito),
        movimiento = coalesce(public.categorias.movimiento, excluded.movimiento),
        subcategorias = coalesce(public.categorias.subcategorias, excluded.subcategorias),
        tipo_gasto = coalesce(public.categorias.tipo_gasto, excluded.tipo_gasto),
        orden = coalesce(public.categorias.orden, excluded.orden);
  get diagnostics v_n = row_count;
  return v_n;
end; $function$;

create table if not exists public.perfiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nombre text,
  edad integer check (edad is null or edad between 14 and 120),
  telefono text check (telefono is null or length(telefono) <= 30),
  correo text,
  usos text[] not null default '{}',
  origen text not null default 'web',
  acepta_datos boolean not null default false,
  acepta_datos_en timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.perfiles enable row level security;
create policy "perfiles: ver el propio" on public.perfiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "perfiles: crear el propio" on public.perfiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "perfiles: editar el propio" on public.perfiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update on public.perfiles to authenticated;

-- La persona no cambia por su cuenta el correo, los usos ni el origen: los llena la base
create or replace function public._perfil_completar() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  new.updated_at := now();
  select u.email into new.correo from auth.users u where u.id = new.user_id;
  new.usos := coalesce((select array_agg(p.plantilla order by p.plantilla) from public.plantillas_usuario p where p.user_id = new.user_id and p.activa), '{}');
  if tg_op = 'UPDATE' then new.origen := old.origen; new.created_at := old.created_at; end if;
  if new.acepta_datos and new.acepta_datos_en is null then new.acepta_datos_en := now(); end if;
  new.nombre := nullif(trim(new.nombre), ''); new.telefono := nullif(trim(new.telefono), '');
  return new;
end $$;
revoke execute on function public._perfil_completar() from public, anon, authenticated;
create or replace trigger perfiles_completar before insert or update on public.perfiles for each row execute function public._perfil_completar();

-- Los usos del perfil siguen a las plantillas activas
create or replace function public._perfil_usos() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  update public.perfiles f set usos = coalesce((select array_agg(p.plantilla order by p.plantilla) from public.plantillas_usuario p where p.user_id = f.user_id and p.activa), '{}'), updated_at = now()
   where f.user_id = coalesce(new.user_id, old.user_id);
  return null;
end $$;
revoke execute on function public._perfil_usos() from public, anon, authenticated;
create or replace trigger plantillas_usuario_perfil after insert or update or delete on public.plantillas_usuario for each row execute function public._perfil_usos();

-- Al registrarse: perfil con lo que escribió y sus plantillas (sin "usos" = cuenta creada por el administrador)
create or replace function public.crear_categorias_iniciales()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare v_m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); v_usos jsonb := v_m -> 'usos'; v_p text; v_edad integer;
begin
  begin
    v_edad := case when (v_m->>'edad') ~ '^\d{1,3}$' and (v_m->>'edad')::int between 14 and 120 then (v_m->>'edad')::int end;
    insert into public.perfiles (user_id, nombre, edad, telefono, origen, acepta_datos)
    values (new.id, left(v_m->>'nombre', 120), v_edad, left(v_m->>'telefono', 30),
            case when v_usos is null then 'administrador' else 'web' end, coalesce((v_m->>'acepta_datos')::boolean, false))
    on conflict (user_id) do nothing;
  exception when others then null;   -- el perfil nunca impide el registro; la web lo completa al entrar
  end;
  if v_usos is not null and jsonb_typeof(v_usos) = 'array' then
    begin
      perform public._copiar_plantilla(new.id, 'personal');
      for v_p in select distinct x from jsonb_array_elements_text(v_usos) as x where x in ('taxista','obra','vendedor') loop
        perform public._copiar_plantilla(new.id, v_p);
      end loop;
      return new;
    exception when others then null;  -- si falla, quedan las categorías genéricas y la web pregunta el uso
    end;
  end if;
  insert into public.categorias (user_id, tipo, nombre)
  select new.id, c.tipo, c.nombre from (values
    ('Ingreso','Efectivo a cuenta'),('Ingreso','Depósitos / Yape a cuenta'),('Ingreso','Depósito a cuenta'),
    ('Ingreso','Pago recibido'),('Ingreso','Transferencia recibida'),
    ('Gasto','Alimentos'),('Gasto','Compras personales'),('Gasto','Material de trabajo'),
    ('Gasto','Depósitos / Yape a terceros'),('Gasto','Efectivo a terceros'),('Gasto','Efectivo para mí'),
    ('Gasto','Transferencia a mi cuenta'),('Gasto','Otros gastos')
  ) as c(tipo, nombre)
  on conflict do nothing;
  return new;
end; $function$;

-- Si cambia el correo en Auth, cambia en el perfil
create or replace function public._perfil_correo() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.email is distinct from old.email then update public.perfiles set correo = new.email, updated_at = now() where user_id = new.id; end if;
  return new;
end $$;
revoke execute on function public._perfil_correo() from public, anon, authenticated;
create or replace trigger al_cambiar_correo after update of email on auth.users for each row execute function public._perfil_correo();

-- Perfiles para las cuentas que ya existían
insert into public.perfiles (user_id, nombre, origen)
select u.id, u.raw_user_meta_data->>'nombre', 'administrador' from auth.users u
on conflict (user_id) do nothing;

-- Clave de la hoja de registro (independiente de la del IMPORTDATA)
create or replace function public._clave_registro_ok(p_clave text) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.config_privada c where c.nombre in ('clave_registro','clave_hoja')
                  and c.valor_hash = encode(extensions.digest(coalesce(p_clave, ''), 'sha256'), 'hex'));
$$;
revoke execute on function public._clave_registro_ok(text) from public, anon, authenticated;

create or replace function public.generar_clave_registro() returns text
language plpgsql security definer set search_path to '' as $$
declare v_clave text;
begin
  if not exists (select 1 from public.administradores a where a.user_id = auth.uid()) then raise exception 'Solo el administrador puede crear esta clave'; end if;
  v_clave := 'regp_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.config_privada (nombre, valor_hash, updated_at) values ('clave_registro', encode(extensions.digest(v_clave, 'sha256'), 'hex'), now())
  on conflict (nombre) do update set valor_hash = excluded.valor_hash, updated_at = now();
  return v_clave;
end $$;
revoke execute on function public.generar_clave_registro() from public, anon;
grant execute on function public.generar_clave_registro() to authenticated;

create or replace function public.registro_usuarios(p_clave text) returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public._clave_registro_ok(p_clave) then raise exception 'Clave de la hoja no válida'; end if;
  return (select coalesce(json_agg(x order by x.registro), '[]'::json) from (
    select u.id, coalesce(f.nombre, u.raw_user_meta_data->>'nombre', '') as nombre, f.edad, coalesce(f.telefono, '') as telefono, u.email as correo,
           coalesce(f.usos, '{}') as usos, coalesce(f.origen, '') as origen, coalesce(f.acepta_datos, false) as acepta_datos,
           u.created_at as registro, u.email_confirmed_at is not null as confirmado, u.last_sign_in_at as ultimo_ingreso,
           coalesce(f.updated_at, u.created_at) as actualizado,
           (select count(*) from public.movimientos m where m.user_id = u.id) as movimientos,
           (select max(m.fecha) from public.movimientos m where m.user_id = u.id) as ultimo_movimiento,
           (select coalesce(sum(m.efecto_caja) filter (where m.efecto_caja > 0), 0) from public.movimientos m where m.user_id = u.id) as ingresos,
           (select coalesce(-sum(m.efecto_caja) filter (where m.efecto_caja < 0), 0) from public.movimientos m where m.user_id = u.id) as gastos,
           (select coalesce(sum(m.efecto_caja), 0) from public.movimientos m where m.user_id = u.id) as saldo,
           exists (select 1 from public.claves_atajo k where k.user_id = u.id) as atajo,
           exists (select 1 from public.claves_hoja_usuario k where k.user_id = u.id) as hoja,
           exists (select 1 from public.administradores a where a.user_id = u.id) as admin
      from auth.users u left join public.perfiles f on f.user_id = u.id) x);
end $$;
revoke execute on function public.registro_usuarios(text) from public;
grant execute on function public.registro_usuarios(text) to anon, authenticated;

-- Correcciones hechas en la hoja: [{id, nombre, edad, telefono}] → por fila ok o el motivo
create or replace function public.registro_guardar(p_clave text, p_filas jsonb) returns json
language plpgsql security definer set search_path to '' as $$
declare f jsonb; v_id uuid; v_edad integer; v_res jsonb := '[]'::jsonb; v_e text;
begin
  if not public._clave_registro_ok(p_clave) then raise exception 'Clave de la hoja no válida'; end if;
  if jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) > 500 then raise exception 'Formato no válido'; end if;
  for f in select * from jsonb_array_elements(p_filas) loop
    begin
      v_id := (f->>'id')::uuid;
      v_e := nullif(trim(coalesce(f->>'edad', '')), '');
      if v_e is not null and (v_e !~ '^\d{1,3}$' or v_e::int not between 14 and 120) then raise exception 'La edad debe ser un número entre 14 y 120'; end if;
      v_edad := v_e::int;
      if not exists (select 1 from auth.users u where u.id = v_id) then raise exception 'Esa cuenta ya no existe'; end if;
      insert into public.perfiles (user_id, nombre, edad, telefono, origen) values (v_id, left(f->>'nombre', 120), v_edad, left(f->>'telefono', 30), 'administrador')
      on conflict (user_id) do update set nombre = excluded.nombre, edad = excluded.edad, telefono = excluded.telefono;
      update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('nombre', nullif(trim(f->>'nombre'), ''))
       where id = v_id and nullif(trim(f->>'nombre'), '') is not null;
      v_res := v_res || jsonb_build_object('id', v_id, 'ok', true);
    exception when others then
      v_res := v_res || jsonb_build_object('id', f->>'id', 'ok', false, 'error', sqlerrm);
    end;
  end loop;
  return v_res;
end $$;
revoke execute on function public.registro_guardar(text, jsonb) from public;
grant execute on function public.registro_guardar(text, jsonb) to anon, authenticated;
