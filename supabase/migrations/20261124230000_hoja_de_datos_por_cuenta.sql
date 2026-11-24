-- Hoja de datos por cuenta: al registrarse en la web, el script de la hoja "Registro de cuentas"
-- crea una hoja de Google para la persona (en el Drive de Caja Personal), se la comparte a su correo
-- y copia ahí sus movimientos cada minuto. La persona ve el enlace en "Mi perfil".

alter table public.perfiles
  add column if not exists hoja_id text,
  add column if not exists hoja_url text,
  add column if not exists hoja_estado text check (hoja_estado is null or hoja_estado in ('pendiente','lista','error')),
  add column if not exists hoja_nota text,
  add column if not exists hoja_creada timestamptz;

-- La persona no puede cambiar los datos de su hoja: solo el script del administrador (sin sesión)
create or replace function public._perfil_completar() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  new.updated_at := now();
  select u.email into new.correo from auth.users u where u.id = new.user_id;
  new.usos := coalesce((select array_agg(p.plantilla order by p.plantilla) from public.plantillas_usuario p where p.user_id = new.user_id and p.activa), '{}');
  if tg_op = 'UPDATE' then new.origen := old.origen; new.created_at := old.created_at; end if;
  if auth.uid() is not null then
    if tg_op = 'UPDATE' then
      new.hoja_id := old.hoja_id; new.hoja_url := old.hoja_url; new.hoja_estado := old.hoja_estado;
      new.hoja_nota := old.hoja_nota; new.hoja_creada := old.hoja_creada;
    else
      new.hoja_id := null; new.hoja_url := null; new.hoja_estado := null; new.hoja_nota := null; new.hoja_creada := null;
    end if;
  end if;
  if new.acepta_datos and new.acepta_datos_en is null then new.acepta_datos_en := now(); end if;
  new.nombre := nullif(trim(new.nombre), ''); new.telefono := nullif(trim(new.telefono), '');
  return new;
end $$;

-- Lista para la hoja del administrador: agrega la hoja de cada persona y una huella de sus movimientos
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
           exists (select 1 from public.administradores a where a.user_id = u.id) as admin,
           f.hoja_id, f.hoja_url, f.hoja_estado, f.hoja_nota,
           (f.hoja_id is null and u.email_confirmed_at is not null and (coalesce(f.origen, '') = 'web' or f.hoja_estado = 'pendiente')) as necesita_hoja,
           (select count(*) || '|' || coalesce(max(greatest(m.updated_at, m.created_at))::text, '')
              from public.movimientos m where m.user_id = u.id) || '|' || coalesce(f.nombre, '') as huella
      from auth.users u left join public.perfiles f on f.user_id = u.id) x);
end $$;
revoke execute on function public.registro_usuarios(text) from public;
grant execute on function public.registro_usuarios(text) to anon, authenticated;

-- El script avisa la hoja creada (o el motivo si no se pudo)
create or replace function public.hoja_registrar(p_clave text, p_user uuid, p_id text, p_url text, p_estado text, p_nota text)
returns json language plpgsql security definer set search_path to '' as $$
begin
  if not public._clave_registro_ok(p_clave) then raise exception 'Clave de la hoja no válida'; end if;
  if p_estado not in ('pendiente','lista','error') then raise exception 'Estado no válido'; end if;
  if p_url is not null and p_url !~ '^https://docs\.google\.com/spreadsheets/' then raise exception 'Enlace no válido'; end if;
  insert into public.perfiles (user_id, origen) values (p_user, 'web') on conflict (user_id) do nothing;
  update public.perfiles set hoja_id = nullif(p_id, ''), hoja_url = nullif(p_url, ''), hoja_estado = p_estado, hoja_nota = left(p_nota, 300),
         hoja_creada = case when p_estado = 'lista' then coalesce(hoja_creada, now()) else hoja_creada end
   where user_id = p_user;
  if not found then raise exception 'Esa cuenta no existe'; end if;
  return json_build_object('ok', true);
end $$;
revoke execute on function public.hoja_registrar(text, uuid, text, text, text, text) from public;
grant execute on function public.hoja_registrar(text, uuid, text, text, text, text) to anon, authenticated;

-- Movimientos de una persona para copiarlos en su hoja
create or replace function public.hoja_movimientos(p_clave text, p_user uuid) returns json
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public._clave_registro_ok(p_clave) then raise exception 'Clave de la hoja no válida'; end if;
  return (select coalesce(json_agg(x order by x.fecha desc, x.registrado desc), '[]'::json) from (
    select m.id, m.fecha, coalesce(m.movimiento, m.tipo) as tipo, coalesce(m.ambito, 'Personal') as ambito, m.categoria, m.subcategoria,
           m.descripcion, m.monto, m.efecto_caja as efecto, m.medio, m.persona, coalesce(m.estado, '') as estado,
           m.created_at as registrado, coalesce(m.registrado_nombre, '') as quien
      from public.movimientos m where m.user_id = p_user) x);
end $$;
revoke execute on function public.hoja_movimientos(text, uuid) from public;
grant execute on function public.hoja_movimientos(text, uuid) to anon, authenticated;
