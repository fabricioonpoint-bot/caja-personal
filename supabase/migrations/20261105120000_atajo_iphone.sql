-- Atajo de iPhone: cada usuario genera una clave personal desde la web.
-- El atajo llama a funciones públicas que validan esa clave y guardan en la cuenta de su dueño.
-- Solo se guarda el hash (sha256) de la clave; la clave completa se muestra una vez al generarla.

create table public.claves_atajo (
  user_id uuid primary key references auth.users(id) on delete cascade,
  clave_hash text not null unique,
  pista text not null,            -- últimos 4 caracteres, para reconocerla
  created_at timestamptz not null default now(),
  ultimo_uso timestamptz
);
alter table public.claves_atajo enable row level security;
create policy "claves_atajo: ver propia" on public.claves_atajo for select to authenticated using ((select auth.uid()) = user_id);
create policy "claves_atajo: borrar propia" on public.claves_atajo for delete to authenticated using ((select auth.uid()) = user_id);

-- Genera (o reemplaza) la clave del usuario conectado y la devuelve una sola vez.
create or replace function public.generar_clave_atajo()
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_clave text;
begin
  if v_uid is null then raise exception 'Debes iniciar sesión'; end if;
  v_clave := 'caja_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.claves_atajo (user_id, clave_hash, pista)
  values (v_uid, encode(extensions.digest(v_clave, 'sha256'), 'hex'), right(v_clave, 4))
  on conflict (user_id) do update
    set clave_hash = excluded.clave_hash, pista = excluded.pista, created_at = now(), ultimo_uso = null;
  return v_clave;
end; $$;
revoke execute on function public.generar_clave_atajo() from public, anon;
grant execute on function public.generar_clave_atajo() to authenticated;

-- Uso interno: devuelve el dueño de una clave o lanza error.
create or replace function public._usuario_de_clave(p_clave text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  select user_id into v_uid from public.claves_atajo
   where clave_hash = encode(extensions.digest(coalesce(p_clave, ''), 'sha256'), 'hex');
  if v_uid is null then raise exception 'Clave del atajo no válida. Genera una nueva en la web.'; end if;
  update public.claves_atajo set ultimo_uso = now() where user_id = v_uid;
  return v_uid;
end; $$;
revoke execute on function public._usuario_de_clave(text) from public, anon, authenticated;

-- Lista de categorías del usuario para el menú del atajo.
create or replace function public.categorias_atajo(p_clave text, p_tipo text)
returns text[] language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._usuario_de_clave(p_clave);
begin
  return coalesce((select array_agg(nombre order by id) from public.categorias
                    where user_id = v_uid and tipo = initcap(trim(p_tipo))), array[]::text[]);
end; $$;
revoke execute on function public.categorias_atajo(text, text) from public;
grant execute on function public.categorias_atajo(text, text) to anon, authenticated;

-- Registra un movimiento desde el atajo y devuelve un mensaje listo para la notificación.
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

  select coalesce(sum(case when tipo = 'Ingreso' then monto else -monto end), 0) into v_saldo
    from public.movimientos where user_id = v_uid;

  return json_build_object(
    'ok', true, 'id', v_id, 'saldo', v_saldo,
    'mensaje', v_tipo || ' de S/ ' || to_char(v_monto, 'FM999G999G990D00') || ' guardado (' || v_cat || '). Saldo: S/ ' || to_char(v_saldo, 'FM999G999G990D00')
  );
end; $$;
revoke execute on function public.registrar_atajo(text, text, numeric, text, text, text, text, date) from public;
grant execute on function public.registrar_atajo(text, text, numeric, text, text, text, text, date) to anon, authenticated;
