-- Modelo administrado: el administrador crea las cuentas y activa una hoja de Google por persona.
-- La hoja sincroniza en doble vía con la plataforma usando una clave propia de cada persona.

-- 1. Administradores -------------------------------------------------------
create table public.administradores (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.administradores enable row level security;
create policy "administradores: verse a sí mismo" on public.administradores for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.administradores where user_id = auth.uid());
$$;
revoke execute on function public.es_admin() from public, anon;
grant execute on function public.es_admin() to authenticated;

-- ¿Ya existe un administrador? (la pantalla de entrada solo ofrece "Crear cuenta" mientras no exista)
create or replace function public.hay_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.administradores);
$$;
revoke execute on function public.hay_admin() from public;
grant execute on function public.hay_admin() to anon, authenticated;

-- La primera cuenta con el correo del dueño queda como administrador.
-- En este archivo va un correo de ejemplo: al aplicarlo, pon el correo real del administrador.
create or replace function public.promover_dueno()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if lower(new.email) = 'admin@ejemplo.com' then
    insert into public.administradores (user_id) values (new.id) on conflict do nothing;
  end if;
  return new;
end; $$;
revoke execute on function public.promover_dueno() from public, anon, authenticated;
create trigger al_crear_usuario_admin after insert on auth.users
  for each row execute function public.promover_dueno();

-- 2. Movimientos que vienen de la hoja ------------------------------------
alter table public.movimientos drop constraint movimientos_origen_check;
alter table public.movimientos add constraint movimientos_origen_check
  check (origen in ('web','atajo','foto','importado','hoja'));
alter table public.movimientos add column updated_at timestamptz not null default now();

-- 3. Clave de la hoja de cada persona (solo se guarda el hash) ---------------
create table public.claves_hoja_usuario (
  user_id uuid primary key references auth.users(id) on delete cascade,
  clave_hash text not null unique,
  pista text not null,
  created_at timestamptz not null default now(),
  ultimo_uso timestamptz
);
alter table public.claves_hoja_usuario enable row level security;   -- sin políticas: solo funciones

create or replace function public._usuario_de_clave_hoja(p_clave text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  select user_id into v_uid from public.claves_hoja_usuario
   where clave_hash = encode(extensions.digest(coalesce(p_clave, ''), 'sha256'), 'hex');
  if v_uid is null then raise exception 'Clave de la hoja no válida. Pide una nueva al administrador.'; end if;
  update public.claves_hoja_usuario set ultimo_uso = now() where user_id = v_uid;
  return v_uid;
end; $$;
revoke execute on function public._usuario_de_clave_hoja(text) from public, anon, authenticated;

-- Genera la clave de hoja de un usuario (la llama la función web de administración).
create or replace function public.generar_clave_hoja_usuario(p_user uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_clave text := 'hojap_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  insert into public.claves_hoja_usuario (user_id, clave_hash, pista)
  values (p_user, encode(extensions.digest(v_clave, 'sha256'), 'hex'), right(v_clave, 4))
  on conflict (user_id) do update set clave_hash = excluded.clave_hash, pista = excluded.pista, created_at = now(), ultimo_uso = null;
  return v_clave;
end; $$;
revoke execute on function public.generar_clave_hoja_usuario(uuid) from public, anon, authenticated;
grant execute on function public.generar_clave_hoja_usuario(uuid) to service_role;

-- 4. Lectura y escritura desde la hoja --------------------------------------
create or replace function public.hoja_leer(p_clave text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._usuario_de_clave_hoja(p_clave);
begin
  return json_build_object(
    'nombre', (select coalesce(raw_user_meta_data->>'nombre', '') from auth.users where id = v_uid),
    'correo', (select email from auth.users where id = v_uid),
    'categorias', (select json_build_object(
        'Ingreso', coalesce(json_agg(nombre order by id) filter (where tipo = 'Ingreso'), '[]'::json),
        'Gasto',   coalesce(json_agg(nombre order by id) filter (where tipo = 'Gasto'), '[]'::json))
      from public.categorias where user_id = v_uid),
    'movimientos', coalesce((select json_agg(json_build_object(
        'id', id, 'fecha', fecha, 'tipo', tipo, 'categoria', categoria, 'subcategoria', subcategoria,
        'descripcion', descripcion, 'persona', persona, 'medio', medio, 'monto', monto, 'origen', origen)
        order by fecha desc, created_at desc) from public.movimientos where user_id = v_uid), '[]'::json)
  );
end; $$;
revoke execute on function public.hoja_leer(text) from public;
grant execute on function public.hoja_leer(text) to anon, authenticated;

-- p_filas: [{fila, id?, borrar?, fecha, tipo, categoria, subcategoria, descripcion, persona, medio, monto}]
-- Devuelve [{fila, id, estado}] donde estado es 'ok', 'borrado' o el mensaje de error de esa fila.
create or replace function public.hoja_guardar(p_clave text, p_filas jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._usuario_de_clave_hoja(p_clave);
  f jsonb; v_id uuid; v_tipo text; v_monto numeric; v_fecha date; v_cat text;
  res jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) > 2000 then
    raise exception 'Formato de filas no válido';
  end if;
  for f in select * from jsonb_array_elements(p_filas) loop
    begin
      v_id := nullif(f->>'id', '')::uuid;
      if coalesce((f->>'borrar')::boolean, false) then
        if v_id is not null then delete from public.movimientos where id = v_id and user_id = v_uid; end if;
        res := res || jsonb_build_object('fila', f->'fila', 'id', null, 'estado', 'borrado');
        continue;
      end if;
      v_tipo := initcap(trim(coalesce(f->>'tipo', '')));
      if v_tipo not in ('Ingreso', 'Gasto') then raise exception 'Tipo debe ser Ingreso o Gasto'; end if;
      v_monto := round((f->>'monto')::numeric, 2);
      if v_monto is null or v_monto <= 0 then raise exception 'Monto debe ser mayor que 0'; end if;
      v_fecha := coalesce(nullif(f->>'fecha', '')::date, (now() at time zone 'America/Lima')::date);
      v_cat := coalesce(nullif(trim(coalesce(f->>'categoria', '')), ''), case v_tipo when 'Gasto' then 'Otros gastos' else 'Pago recibido' end);
      if v_id is null then
        insert into public.movimientos (user_id, fecha, tipo, categoria, subcategoria, descripcion, persona, medio, monto, origen)
        values (v_uid, v_fecha, v_tipo, v_cat, nullif(trim(coalesce(f->>'subcategoria','')),''),
                coalesce(nullif(trim(coalesce(f->>'descripcion','')),''), v_cat),
                nullif(trim(coalesce(f->>'persona','')),''), nullif(trim(coalesce(f->>'medio','')),''), v_monto, 'hoja')
        returning id into v_id;
      else
        update public.movimientos set fecha = v_fecha, tipo = v_tipo, categoria = v_cat,
               subcategoria = nullif(trim(coalesce(f->>'subcategoria','')),''),
               descripcion = coalesce(nullif(trim(coalesce(f->>'descripcion','')),''), v_cat),
               persona = nullif(trim(coalesce(f->>'persona','')),''), medio = nullif(trim(coalesce(f->>'medio','')),''),
               monto = v_monto, updated_at = now()
         where id = v_id and user_id = v_uid;
        if not found then raise exception 'Ese movimiento ya no existe en la plataforma'; end if;
      end if;
      res := res || jsonb_build_object('fila', f->'fila', 'id', v_id, 'estado', 'ok');
    exception when others then
      res := res || jsonb_build_object('fila', f->'fila', 'id', f->>'id', 'estado', sqlerrm);
    end;
  end loop;
  return res::json;
end; $$;
revoke execute on function public.hoja_guardar(text, jsonb) from public;
grant execute on function public.hoja_guardar(text, jsonb) to anon, authenticated;

-- 5. Lista de cuentas para el panel del administrador ------------------------
create or replace function public.admin_cuentas()
returns table (user_id uuid, nombre text, correo text, creada timestamptz, ultimo_ingreso timestamptz,
               movimientos bigint, saldo numeric, hoja_pista text, hoja_ultimo_uso timestamptz, es_admin boolean)
language sql stable security definer set search_path = '' as $$
  select u.id, coalesce(u.raw_user_meta_data->>'nombre', ''), u.email::text, u.created_at, u.last_sign_in_at,
         (select count(*) from public.movimientos m where m.user_id = u.id),
         (select coalesce(sum(case when m.tipo = 'Ingreso' then m.monto else -m.monto end), 0) from public.movimientos m where m.user_id = u.id),
         k.pista, k.ultimo_uso,
         exists (select 1 from public.administradores a where a.user_id = u.id)
    from auth.users u left join public.claves_hoja_usuario k on k.user_id = u.id
   order by u.created_at;
$$;
revoke execute on function public.admin_cuentas() from public, anon, authenticated;
grant execute on function public.admin_cuentas() to service_role;
