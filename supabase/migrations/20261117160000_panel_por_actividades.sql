-- Panel por actividades (Taxi · Ventas · Obra · Personal), presupuesto y pagos fijos desde la hoja,
-- y estado de la sincronización visible en la web. Aditiva: no cambia cómo se guardan los movimientos.

-- 1. Configuración que llega de la hoja (presupuesto por grupo y mes, pagos fijos) ------------------
create table if not exists public.cuenta_config (
  user_id uuid primary key references auth.users(id) on delete cascade,
  presupuesto jsonb not null default '{}'::jsonb,   -- {anio, grupos:[{grupo, limites:[12]}], mapa:{categoria: grupo}, verde, amarillo}
  fijos jsonb not null default '[]'::jsonb,          -- [{id, servicio, categoria, proveedor, previsto, frecuencia, dia, activo}]
  hoja jsonb not null default '{}'::jsonb,           -- {filas, errores, version, aviso}
  updated_at timestamptz not null default now()
);
alter table public.cuenta_config enable row level security;
drop policy if exists "cuenta_config: ver propia o compartida" on public.cuenta_config;
create policy "cuenta_config: ver propia o compartida" on public.cuenta_config for select to authenticated
  using ((select auth.uid()) = user_id or public.puede_ver(user_id));

-- La hoja manda su configuración con la misma clave de hoja. Solo reemplaza las partes que trae.
create or replace function public.cg_config(p_clave text, p_config jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._usuario_de_clave_hoja(p_clave);
begin
  if jsonb_typeof(p_config) <> 'object' or length(p_config::text) > 200000 then raise exception 'Configuración no válida'; end if;
  insert into public.cuenta_config as c (user_id, presupuesto, fijos, hoja, updated_at)
  values (v_uid, coalesce(p_config->'presupuesto', '{}'::jsonb), coalesce(p_config->'fijos', '[]'::jsonb),
          coalesce(p_config->'hoja', '{}'::jsonb), now())
  on conflict (user_id) do update set
    presupuesto = coalesce(p_config->'presupuesto', c.presupuesto),
    fijos = coalesce(p_config->'fijos', c.fijos),
    hoja = coalesce(p_config->'hoja', c.hoja),
    updated_at = now();
  return json_build_object('ok', true);
end; $$;
revoke execute on function public.cg_config(text, jsonb) from public;
grant execute on function public.cg_config(text, jsonb) to anon, authenticated;

-- 2. Pulso de la cuenta: la web lo consulta cada minuto y recarga solo si algo cambió ------------------
create or replace function public.estado_cuenta(p_user uuid default null)
returns json language plpgsql stable security definer set search_path = '' as $$
declare v uuid := coalesce(p_user, auth.uid());
begin
  if v is null or not (v = auth.uid() or public.puede_ver(v)) then raise exception 'Sin acceso a esta cuenta'; end if;
  return json_build_object(
    'movimientos', (select count(*) from public.movimientos where user_id = v),
    'cambio', (select max(updated_at) from public.movimientos where user_id = v),
    'eliminado', (select max(eliminado_at) from public.movimientos_eliminados where user_id = v),
    'config', (select updated_at from public.cuenta_config where user_id = v),
    'hoja_clave', exists (select 1 from public.claves_hoja_usuario where user_id = v),
    'hoja_visto', (select ultimo_uso from public.claves_hoja_usuario where user_id = v),
    'ahora', now());
end; $$;
revoke execute on function public.estado_cuenta(uuid) from public, anon;
grant execute on function public.estado_cuenta(uuid) to authenticated;

-- 3. Módulos (plantillas) visibles también para quien tiene la cuenta compartida ----------------------
drop policy if exists "plantillas_usuario: ver compartidas" on public.plantillas_usuario;
create policy "plantillas_usuario: ver compartidas" on public.plantillas_usuario for select to authenticated
  using (public.puede_ver(user_id));

-- 4. Lo que entra por el atajo o un formulario simple toma el ámbito de su categoría ---------------------
-- (antes todo caía en Personal: un ingreso "UBER" desde el atajo ahora va a Auto).
create or replace function public._completar_movimiento()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.movimiento is null
     and (exists (select 1 from public.movimientos x where x.user_id = new.user_id and x.movimiento is not null)
          or exists (select 1 from public.plantillas_usuario p where p.user_id = new.user_id and p.activa)) then
    new.movimiento := new.tipo;
    new.ambito := coalesce(new.ambito,
      (select c.ambito from public.categorias c where c.user_id = new.user_id and c.tipo = new.tipo and c.nombre = new.categoria and c.ambito is not null limit 1),
      (select x.ambito from public.movimientos x where x.user_id = new.user_id and x.tipo = new.tipo and x.categoria = new.categoria and x.ambito is not null
        group by x.ambito order by count(*) desc limit 1),
      'Personal');
    new.tipo_gasto := coalesce(new.tipo_gasto,
      (select c.tipo_gasto from public.categorias c where c.user_id = new.user_id and c.tipo = new.tipo and c.nombre = new.categoria limit 1),
      case when new.tipo = 'Gasto' then 'Variable' else 'No aplica' end);
    new.estado := coalesce(new.estado, case when new.tipo = 'Gasto' then 'Pagado' else 'Cobrado' end);
    if new.persona is not null and coalesce(new.extra->>'Nota', '') = '' then
      new.extra := coalesce(new.extra, '{}'::jsonb) || jsonb_build_object('Nota', 'Persona: ' || new.persona);
    end if;
    new.extra := coalesce(new.extra, '{}'::jsonb) || jsonb_build_object('Origen', 'Caja Personal · ' || new.origen);
  end if;
  if new.movimiento is not null then
    new.tipo := case when new.movimiento in ('Ingreso','Venta','Préstamo recibido','Cambio USD') then 'Ingreso' else 'Gasto' end;
  end if;
  if tg_op = 'INSERT' and new.ref_hoja is null and new.movimiento is not null then
    new.ref_hoja := 'CP-' || upper(substr(replace(new.id::text, '-', ''), 1, 10));
  end if;
  new.cambio_via := coalesce(nullif(current_setting('cp.via', true), ''), 'plataforma');
  return new;
end; $$;
revoke execute on function public._completar_movimiento() from public, anon, authenticated;

-- 5. estado_cuenta exige sesión (sin sesión, la comparación daba nulo y no se rechazaba) ----------------
create or replace function public.estado_cuenta(p_user uuid default null)
returns json language plpgsql stable security definer set search_path = '' as $$
declare v uuid := coalesce(p_user, auth.uid());
begin
  if auth.uid() is null or v is null or not coalesce(v = auth.uid() or public.puede_ver(v), false) then
    raise exception 'Sin acceso a esta cuenta';
  end if;
  return json_build_object(
    'movimientos', (select count(*) from public.movimientos where user_id = v),
    'cambio', (select max(updated_at) from public.movimientos where user_id = v),
    'eliminado', (select max(eliminado_at) from public.movimientos_eliminados where user_id = v),
    'config', (select updated_at from public.cuenta_config where user_id = v),
    'hoja_clave', exists (select 1 from public.claves_hoja_usuario where user_id = v),
    'hoja_visto', (select ultimo_uso from public.claves_hoja_usuario where user_id = v),
    'ahora', now());
end; $$;
revoke execute on function public.estado_cuenta(uuid) from public, anon;
grant execute on function public.estado_cuenta(uuid) to authenticated;
