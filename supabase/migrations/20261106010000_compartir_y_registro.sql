-- 1) Entradas "a cuenta" ------------------------------------------------------
update public.movimientos set categoria = 'Efectivo a cuenta'          where tipo = 'Ingreso' and categoria = 'Efectivo recibido';
update public.movimientos set categoria = 'Depósitos / Yape a cuenta'  where tipo = 'Ingreso' and categoria in ('Depósitos / Yape recibidos', 'Depósito Yape');
update public.movimientos set categoria = 'Depósito a cuenta'          where tipo = 'Ingreso' and categoria in ('Depósito a cuenta FAB', 'Depósito en cajero');
update public.categorias  set nombre = 'Efectivo a cuenta'             where tipo = 'Ingreso' and nombre = 'Efectivo recibido';
update public.categorias  set nombre = 'Depósitos / Yape a cuenta'     where tipo = 'Ingreso' and nombre = 'Depósitos / Yape recibidos';
update public.categorias  set nombre = 'Depósito a cuenta'             where tipo = 'Ingreso' and nombre = 'Depósito a cuenta FAB';

create or replace function public.crear_categorias_iniciales()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categorias (user_id, tipo, nombre)
  select new.id, c.tipo, c.nombre from (values
    ('Ingreso','Efectivo a cuenta'),('Ingreso','Depósitos / Yape a cuenta'),('Ingreso','Depósito a cuenta'),
    ('Ingreso','Pago recibido'),('Ingreso','Transferencia recibida'),
    ('Gasto','Alimentos'),('Gasto','Compras personales'),('Gasto','Material de trabajo'),
    ('Gasto','Depósitos / Yape a terceros'),('Gasto','Efectivo a terceros'),('Gasto','Efectivo para mí'),
    ('Gasto','Transferencia a mi cuenta'),('Gasto','Otros gastos')
  ) as c(tipo, nombre);
  return new;
end; $$;
revoke execute on function public.crear_categorias_iniciales() from public, anon, authenticated;

-- 2) Quién registró cada movimiento -----------------------------------------
-- Desde la web es la persona con la sesión abierta; desde el atajo o la hoja, el dueño de la cuenta.
alter table public.movimientos
  add column registrado_por uuid references auth.users(id) on delete set null,
  add column registrado_nombre text;

create or replace function public._marcar_registro()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid := coalesce(auth.uid(), new.user_id);
begin
  new.registrado_por := v;
  new.registrado_nombre := (select coalesce(nullif(u.raw_user_meta_data->>'nombre', ''), u.email) from auth.users u where u.id = v);
  return new;
end; $$;
revoke execute on function public._marcar_registro() from public, anon, authenticated;
create trigger marcar_registro before insert on public.movimientos
  for each row execute function public._marcar_registro();

update public.movimientos m
   set registrado_por = m.user_id,
       registrado_nombre = (select coalesce(nullif(u.raw_user_meta_data->>'nombre', ''), u.email) from auth.users u where u.id = m.user_id)
 where m.registrado_por is null;

-- 3) Compartir la cuenta con permiso del dueño --------------------------------
create table public.accesos (
  id bigint generated always as identity primary key,
  dueno_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invitado_correo text not null check (invitado_correo = lower(trim(invitado_correo)) and invitado_correo ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  puede_registrar boolean not null default true,
  created_at timestamptz not null default now(),
  unique (dueno_id, invitado_correo)
);
create index accesos_correo_idx on public.accesos (invitado_correo);
alter table public.accesos enable row level security;
create policy "accesos: el dueño ve los suyos"    on public.accesos for select to authenticated using ((select auth.uid()) = dueno_id);
create policy "accesos: el dueño comparte"        on public.accesos for insert to authenticated with check ((select auth.uid()) = dueno_id);
create policy "accesos: el dueño cambia permisos" on public.accesos for update to authenticated using ((select auth.uid()) = dueno_id) with check ((select auth.uid()) = dueno_id);
create policy "accesos: el dueño quita acceso"    on public.accesos for delete to authenticated using ((select auth.uid()) = dueno_id);

create or replace function public.puede_ver(p_dueno uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.accesos a
                  where a.dueno_id = p_dueno
                    and a.invitado_correo = lower(coalesce(auth.jwt()->>'email', '')));
$$;
create or replace function public.puede_registrar(p_dueno uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.accesos a
                  where a.dueno_id = p_dueno and a.puede_registrar
                    and a.invitado_correo = lower(coalesce(auth.jwt()->>'email', '')));
$$;
revoke execute on function public.puede_ver(uuid), public.puede_registrar(uuid) from public, anon;
grant execute on function public.puede_ver(uuid), public.puede_registrar(uuid) to authenticated;

-- Cuentas que otras personas compartieron conmigo
create or replace function public.cuentas_compartidas()
returns table (dueno_id uuid, nombre text, correo text, puede_registrar boolean)
language sql stable security definer set search_path = '' as $$
  select a.dueno_id, coalesce(nullif(u.raw_user_meta_data->>'nombre', ''), u.email::text), u.email::text, a.puede_registrar
    from public.accesos a join auth.users u on u.id = a.dueno_id
   where a.invitado_correo = lower(coalesce(auth.jwt()->>'email', ''))
   order by 2;
$$;
revoke execute on function public.cuentas_compartidas() from public, anon;
grant execute on function public.cuentas_compartidas() to authenticated;

create policy "movimientos: ver compartidos" on public.movimientos for select to authenticated
  using (public.puede_ver(user_id));
create policy "movimientos: registrar en compartidos" on public.movimientos for insert to authenticated
  with check (public.puede_registrar(user_id));
create policy "movimientos: borrar lo que registré en compartidos" on public.movimientos for delete to authenticated
  using (public.puede_registrar(user_id) and registrado_por = (select auth.uid()));
create policy "categorias: ver compartidas" on public.categorias for select to authenticated
  using (public.puede_ver(user_id));
