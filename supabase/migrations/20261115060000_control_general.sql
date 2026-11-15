-- Control general: la hoja "Control general de gastos personales" (pestaña MOVIMIENTOS) sincroniza
-- en doble vía con la plataforma. Cada movimiento guarda los campos base de la hoja y queda
-- emparejado por su ID de hoja (ref_hoja: AUT-…, VTA-…, REG-…; los creados en la web llevan CP-…).

-- 1. Campos de la hoja ------------------------------------------------------
alter table public.movimientos
  add column if not exists movimiento text,
  add column if not exists tipo_gasto text,
  add column if not exists ambito text,
  add column if not exists estado text,
  add column if not exists cuenta text,
  add column if not exists necesidad text,
  add column if not exists costo numeric(12,2),
  add column if not exists envio numeric(12,2),
  add column if not exists es_prueba boolean not null default false,
  add column if not exists ref_hoja text,
  add column if not exists extra jsonb not null default '{}'::jsonb,
  add column if not exists cambio_via text;

alter table public.movimientos add constraint movimientos_movimiento_check check (movimiento is null or movimiento in
  ('Ingreso','Gasto','Ahorro','Venta','Préstamo recibido','Cambio USD','Pago tarjeta','Pago deuda','Compra mercadería'));
-- La hoja tiene correcciones con monto negativo y anulados con monto 0: se aceptan solo en movimientos de control general.
alter table public.movimientos drop constraint if exists movimientos_monto_check;
alter table public.movimientos add constraint movimientos_monto_check
  check (monto > 0 or (movimiento is not null and (monto < 0 or estado = 'Anulado')));
create unique index if not exists movimientos_ref_hoja_idx on public.movimientos (user_id, ref_hoja) where ref_hoja is not null;
create index if not exists movimientos_user_updated_idx on public.movimientos (user_id, updated_at);

-- Efecto en la caja personal, con las mismas reglas que la hoja (INICIO):
-- en movimientos de control general cuenta solo lo Pagado/Cobrado/Registrado/Histórico que no es prueba; ventas aportan su utilidad;
-- pagos de tarjeta, cuotas de deuda, préstamos recibidos, cambio de moneda, ahorro y compras de mercadería quedan fuera.
alter table public.movimientos add column if not exists efecto_caja numeric(12,2) generated always as (
  case
    when es_prueba then 0
    when movimiento is not null and (estado is null or estado not in ('Pagado','Cobrado','Registrado','Histórico')) then 0
    when estado is not null and estado not in ('Pagado','Cobrado','Registrado','Histórico') then 0
    when coalesce(movimiento, tipo) in ('Pago tarjeta','Pago deuda') or tipo_gasto = 'Deuda' then 0
    when coalesce(movimiento, tipo) = 'Ingreso' then monto
    when coalesce(movimiento, tipo) = 'Venta' then monto - coalesce(costo, 0) - coalesce(envio, 0)
    when coalesce(movimiento, tipo) = 'Gasto' then -monto
    else 0
  end) stored;

alter table public.movimientos_eliminados add column if not exists via text;

-- 2. Coherencia: tipo (entrada/salida) sale de "movimiento"; ID de hoja para lo creado en la web ------------
-- En una cuenta de control general, lo que entra por el atajo o por un formulario simple se completa con los campos de la hoja.
create or replace function public._completar_movimiento()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.movimiento is null
     and exists (select 1 from public.movimientos x where x.user_id = new.user_id and x.movimiento is not null) then
    new.movimiento := new.tipo;
    new.ambito := coalesce(new.ambito, 'Personal');
    new.tipo_gasto := coalesce(new.tipo_gasto, case when new.tipo = 'Gasto' then 'Variable' else 'No aplica' end);
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
drop trigger if exists completar_movimiento on public.movimientos;
create trigger completar_movimiento before insert or update on public.movimientos
  for each row execute function public._completar_movimiento();

create or replace function public._respaldar_eliminado()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid := coalesce(auth.uid(), old.user_id);
begin
  insert into public.movimientos_eliminados (id, user_id, datos, eliminado_por, eliminado_por_nombre, via)
  values (old.id, old.user_id, to_jsonb(old), v,
          case when current_setting('cp.via', true) = 'hoja' then 'Hoja de cálculo'
               else (select coalesce(nullif(u.raw_user_meta_data->>'nombre', ''), u.email) from auth.users u where u.id = v) end,
          coalesce(nullif(current_setting('cp.via', true), ''), 'plataforma'))
  on conflict (id) do nothing;
  return old;
end; $$;
revoke execute on function public._respaldar_eliminado() from public, anon, authenticated;

-- 3. Funciones para la hoja (usan la misma clave de hoja de cada persona) ----------
create or replace function public._cg_fila(m public.movimientos)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'ref', m.ref_hoja, 'fecha', m.fecha, 'movimiento', coalesce(m.movimiento, m.tipo), 'tipo_gasto', m.tipo_gasto,
    'categoria', m.categoria, 'subcategoria', m.subcategoria, 'descripcion', m.descripcion, 'ambito', m.ambito,
    'medio', m.medio, 'monto', m.monto, 'necesidad', m.necesidad, 'estado', m.estado, 'cuenta', m.cuenta,
    'costo', m.costo, 'envio', m.envio, 'es_prueba', m.es_prueba, 'extra', m.extra, 'persona', m.persona,
    'efecto', m.efecto_caja, 'registrado', coalesce(m.registrado_nombre, ''), 'via', m.cambio_via, 'actualizado', m.updated_at);
$$;
revoke execute on function public._cg_fila(public.movimientos) from public, anon, authenticated;

-- A qué cuenta pertenece la clave (al conectar)
create or replace function public.cg_identidad(p_clave text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._usuario_de_clave_hoja(p_clave);
begin
  return (select json_build_object('nombre', coalesce(raw_user_meta_data->>'nombre', ''), 'correo', email,
                                   'movimientos', (select count(*) from public.movimientos m where m.user_id = v_uid))
            from auth.users where id = v_uid);
end; $$;
revoke execute on function public.cg_identidad(text) from public;
grant execute on function public.cg_identidad(text) to anon, authenticated;

-- Todo lo de la cuenta (primera sincronización): movimientos y lo que se eliminó directamente en la plataforma
create or replace function public.cg_todo(p_clave text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._usuario_de_clave_hoja(p_clave);
begin
  return json_build_object(
    'ahora', now(),
    'movimientos', coalesce((select jsonb_agg(public._cg_fila(m) order by m.fecha, m.created_at)
                               from public.movimientos m where m.user_id = v_uid), '[]'::jsonb),
    'eliminados', coalesce((select jsonb_agg(distinct e.datos->>'ref_hoja')
                              from public.movimientos_eliminados e
                             where e.user_id = v_uid and coalesce(e.via, '') <> 'hoja' and e.datos->>'ref_hoja' is not null), '[]'::jsonb));
end; $$;
revoke execute on function public.cg_todo(text) from public;
grant execute on function public.cg_todo(text) to anon, authenticated;

-- Lo que cambió en la plataforma (web, atajo) desde p_desde, sin el eco de lo que mandó la propia hoja
create or replace function public.cg_cambios(p_clave text, p_desde timestamptz)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._usuario_de_clave_hoja(p_clave);
begin
  return json_build_object(
    'ahora', now(),
    'cambios', coalesce((select jsonb_agg(public._cg_fila(m) order by m.updated_at)
                           from public.movimientos m
                          where m.user_id = v_uid and m.updated_at > p_desde and coalesce(m.cambio_via, '') <> 'hoja'), '[]'::jsonb),
    'eliminados', coalesce((select jsonb_agg(e.datos->>'ref_hoja')
                              from public.movimientos_eliminados e
                             where e.user_id = v_uid and e.eliminado_at > p_desde and coalesce(e.via, '') <> 'hoja'
                               and e.datos->>'ref_hoja' is not null), '[]'::jsonb));
end; $$;
revoke execute on function public.cg_cambios(text, timestamptz) from public;
grant execute on function public.cg_cambios(text, timestamptz) to anon, authenticated;

-- p_filas: [{ref, borrar?, fecha, movimiento, tipo_gasto, categoria, subcategoria, descripcion, ambito, medio,
--            monto, necesidad, estado, cuenta, costo, envio, es_prueba, extra}]
-- extra se reemplaza completo: la hoja manda solo las columnas de apoyo con valor.
-- Crea o actualiza por ref (ID de la hoja). Devuelve [{ref, estado}] con 'ok', 'borrado', 'igual' o el error.
create or replace function public._cg_guardar(v_uid uuid, p_filas jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare
  f jsonb; v_ref text; v_mov text; v_monto numeric; v_fecha date; v_cat text; v_n int;
  res jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) > 1000 then raise exception 'Formato de filas no válido'; end if;
  perform set_config('cp.via', 'hoja', true);
  for f in select * from jsonb_array_elements(p_filas) loop
    begin
      v_ref := nullif(trim(coalesce(f->>'ref', '')), '');
      if v_ref is null then raise exception 'Falta el ID'; end if;
      if coalesce((f->>'borrar')::boolean, false) then
        delete from public.movimientos where user_id = v_uid and ref_hoja = v_ref;
        res := res || jsonb_build_object('ref', v_ref, 'estado', 'borrado');
        continue;
      end if;
      v_mov := trim(coalesce(f->>'movimiento', ''));
      if v_mov not in ('Ingreso','Gasto','Ahorro','Venta','Préstamo recibido','Cambio USD','Pago tarjeta','Pago deuda','Compra mercadería') then
        raise exception 'Movimiento no válido: %', v_mov;
      end if;
      v_monto := round(nullif(f->>'monto', '')::numeric, 2);
      if v_monto is null then raise exception 'Falta el monto'; end if;
      if v_monto = 0 and coalesce(f->>'estado', '') <> 'Anulado' then raise exception 'Monto debe ser distinto de 0'; end if;
      v_fecha := coalesce(nullif(f->>'fecha', '')::date, (now() at time zone 'America/Lima')::date);
      v_cat := coalesce(nullif(trim(coalesce(f->>'categoria', '')), ''), case when v_mov = 'Ingreso' then 'Otros ingresos' else 'Otros' end);
      insert into public.movimientos as m (user_id, ref_hoja, fecha, movimiento, tipo, tipo_gasto, categoria, subcategoria, descripcion,
                                      ambito, medio, monto, necesidad, estado, cuenta, costo, envio, es_prueba, extra, origen)
      values (v_uid, v_ref, v_fecha, v_mov, 'Gasto', nullif(f->>'tipo_gasto', ''), v_cat, nullif(f->>'subcategoria', ''),
              coalesce(nullif(f->>'descripcion', ''), v_cat), nullif(f->>'ambito', ''), nullif(f->>'medio', ''), v_monto,
              nullif(f->>'necesidad', ''), nullif(f->>'estado', ''), nullif(f->>'cuenta', ''),
              nullif(f->>'costo', '')::numeric, nullif(f->>'envio', '')::numeric,
              coalesce((f->>'es_prueba')::boolean, false), coalesce(f->'extra', '{}'::jsonb), 'hoja')
      on conflict (user_id, ref_hoja) where ref_hoja is not null do update set
        fecha = excluded.fecha, movimiento = excluded.movimiento, tipo_gasto = excluded.tipo_gasto, categoria = excluded.categoria,
        subcategoria = excluded.subcategoria, descripcion = excluded.descripcion, ambito = excluded.ambito, medio = excluded.medio,
        monto = excluded.monto, necesidad = excluded.necesidad, estado = excluded.estado, cuenta = excluded.cuenta,
        costo = excluded.costo, envio = excluded.envio, es_prueba = excluded.es_prueba, extra = excluded.extra
      where (m.fecha, m.movimiento, m.tipo_gasto, m.categoria, m.subcategoria, m.descripcion, m.ambito, m.medio, m.monto,
             m.necesidad, m.estado, m.cuenta, m.costo, m.envio, m.es_prueba, m.extra)
         is distinct from
            (excluded.fecha, excluded.movimiento, excluded.tipo_gasto, excluded.categoria, excluded.subcategoria, excluded.descripcion,
             excluded.ambito, excluded.medio, excluded.monto, excluded.necesidad, excluded.estado, excluded.cuenta, excluded.costo,
             excluded.envio, excluded.es_prueba, excluded.extra);
      get diagnostics v_n = row_count;
      res := res || jsonb_build_object('ref', v_ref, 'estado', case when v_n = 0 then 'igual' else 'ok' end);
    exception when others then
      res := res || jsonb_build_object('ref', v_ref, 'estado', sqlerrm);
    end;
  end loop;
  return res::json;
end; $$;
revoke execute on function public._cg_guardar(uuid, jsonb) from public, anon, authenticated;

create or replace function public.cg_guardar(p_clave text, p_filas jsonb)
returns json language plpgsql security definer set search_path = '' as $$
begin
  return public._cg_guardar(public._usuario_de_clave_hoja(p_clave), p_filas);
end; $$;
revoke execute on function public.cg_guardar(text, jsonb) from public;
grant execute on function public.cg_guardar(text, jsonb) to anon, authenticated;

-- 4. Saldos: usan el efecto en la caja (en cuentas simples da lo mismo que antes) ----------
create or replace function public.registrar_atajo(
  p_clave text, p_tipo text, p_monto numeric, p_categoria text default null,
  p_descripcion text default null, p_persona text default null, p_medio text default null, p_fecha date default null
) returns json language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._usuario_de_clave(p_clave);
  v_tipo text := initcap(trim(coalesce(p_tipo, '')));
  v_cat text := nullif(trim(coalesce(p_categoria, '')), '');
  v_monto numeric(12,2) := round(p_monto, 2);
  v_saldo numeric(12,2);
  v_id uuid;
begin
  if v_tipo not in ('Ingreso', 'Gasto') then raise exception 'El tipo debe ser Ingreso o Gasto'; end if;
  if v_monto is null or v_monto <= 0 then raise exception 'El monto debe ser mayor que 0'; end if;
  if v_cat is null then v_cat := case v_tipo when 'Gasto' then 'Otros gastos' else 'Pago recibido' end; end if;

  insert into public.movimientos (user_id, fecha, tipo, categoria, descripcion, persona, medio, monto, origen)
  values (v_uid, coalesce(p_fecha, (now() at time zone 'America/Lima')::date), v_tipo, v_cat,
          coalesce(nullif(trim(coalesce(p_descripcion, '')), ''), v_cat),
          nullif(trim(coalesce(p_persona, '')), ''), nullif(trim(coalesce(p_medio, '')), ''), v_monto, 'atajo')
  returning id into v_id;

  select coalesce(sum(efecto_caja), 0) into v_saldo from public.movimientos where user_id = v_uid;

  return json_build_object(
    'ok', true, 'id', v_id, 'saldo', v_saldo,
    'mensaje', v_tipo || ' de S/ ' || to_char(v_monto, 'FM999G999G990D00') || ' guardado (' || v_cat || '). Saldo: S/ ' || to_char(v_saldo, 'FM999G999G990D00')
  );
end; $$;
revoke execute on function public.registrar_atajo(text, text, numeric, text, text, text, text, date) from public;
grant execute on function public.registrar_atajo(text, text, numeric, text, text, text, text, date) to anon, authenticated;

create or replace function public.admin_cuentas()
returns table (user_id uuid, nombre text, correo text, creada timestamptz, ultimo_ingreso timestamptz,
               movimientos bigint, saldo numeric, hoja_pista text, hoja_ultimo_uso timestamptz, es_admin boolean)
language sql stable security definer set search_path = '' as $$
  select u.id, coalesce(u.raw_user_meta_data->>'nombre', ''), u.email::text, u.created_at, u.last_sign_in_at,
         (select count(*) from public.movimientos m where m.user_id = u.id),
         (select coalesce(sum(m.efecto_caja), 0) from public.movimientos m where m.user_id = u.id),
         k.pista, k.ultimo_uso,
         exists (select 1 from public.administradores a where a.user_id = u.id)
    from auth.users u left join public.claves_hoja_usuario k on k.user_id = u.id
   order by u.created_at;
$$;
revoke execute on function public.admin_cuentas() from public, anon, authenticated;
grant execute on function public.admin_cuentas() to service_role;

create or replace function public.cuentas_hoja(p_clave text)
returns table (
  nombre text, correo text, cuenta_creada text, correo_confirmado text, ultimo_ingreso text,
  movimientos bigint, total_ingresos numeric, total_gastos numeric, saldo numeric,
  ultimo_movimiento text, atajo_iphone text
) language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.config_privada c
                  where c.nombre = 'clave_hoja'
                    and c.valor_hash = encode(extensions.digest(coalesce(p_clave, ''), 'sha256'), 'hex')) then
    raise exception 'Clave de la hoja no válida';
  end if;
  return query
  select coalesce(u.raw_user_meta_data->>'nombre', '')::text,
         u.email::text,
         to_char(u.created_at at time zone 'America/Lima', 'DD/MM/YYYY') || ' ' || to_char(u.created_at at time zone 'America/Lima', 'HH24:MI') || ' h',
         case when u.email_confirmed_at is null then 'No' else 'Sí' end,
         coalesce(to_char(u.last_sign_in_at at time zone 'America/Lima', 'DD/MM/YYYY') || ' ' || to_char(u.last_sign_in_at at time zone 'America/Lima', 'HH24:MI') || ' h', 'Nunca'),
         count(m.id),
         coalesce(sum(m.efecto_caja) filter (where m.efecto_caja > 0), 0),
         coalesce(-sum(m.efecto_caja) filter (where m.efecto_caja < 0), 0),
         coalesce(sum(m.efecto_caja), 0),
         coalesce('del ' || to_char(max(m.fecha), 'DD/MM/YYYY'), 'Sin movimientos'),
         case when exists (select 1 from public.claves_atajo k where k.user_id = u.id) then 'Sí' else 'No' end
    from auth.users u
    left join public.movimientos m on m.user_id = u.id
   group by u.id
   order by u.created_at;
end; $$;
revoke execute on function public.cuentas_hoja(text) from public, anon, authenticated;
grant execute on function public.cuentas_hoja(text) to service_role;
