create table public.categorias (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tipo text not null check (tipo in ('Ingreso','Gasto')),
  nombre text not null,
  created_at timestamptz not null default now(),
  unique (user_id, tipo, nombre)
);

create table public.movimientos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fecha date not null default (now() at time zone 'America/Lima')::date,
  tipo text not null check (tipo in ('Ingreso','Gasto')),
  categoria text not null,
  subcategoria text,
  descripcion text,
  persona text,
  medio text,
  monto numeric(12,2) not null check (monto > 0),
  origen text not null default 'web' check (origen in ('web','atajo','foto','importado')),
  created_at timestamptz not null default now()
);
create index movimientos_user_fecha_idx on public.movimientos (user_id, fecha desc);
create index categorias_user_idx on public.categorias (user_id);

alter table public.categorias enable row level security;
alter table public.movimientos enable row level security;

create policy "categorias: ver propias" on public.categorias for select to authenticated using ((select auth.uid()) = user_id);
create policy "categorias: crear propias" on public.categorias for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "categorias: editar propias" on public.categorias for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "categorias: borrar propias" on public.categorias for delete to authenticated using ((select auth.uid()) = user_id);

create policy "movimientos: ver propios" on public.movimientos for select to authenticated using ((select auth.uid()) = user_id);
create policy "movimientos: crear propios" on public.movimientos for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "movimientos: editar propios" on public.movimientos for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "movimientos: borrar propios" on public.movimientos for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.crear_categorias_iniciales()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categorias (user_id, tipo, nombre)
  select new.id, c.tipo, c.nombre from (values
    ('Ingreso','Efectivo recibido'),('Ingreso','Depósito Yape'),('Ingreso','Depósito en cajero'),
    ('Ingreso','Pago recibido'),('Ingreso','Transferencia recibida'),
    ('Gasto','Alimentos'),('Gasto','Compras personales'),('Gasto','Yape a terceros'),
    ('Gasto','Depósitos a terceros'),('Gasto','Efectivo a terceros'),
    ('Gasto','Transferencia a mi cuenta'),('Gasto','Otros gastos')
  ) as c(tipo, nombre);
  return new;
end; $$;
revoke execute on function public.crear_categorias_iniciales() from public, anon, authenticated;

create trigger al_crear_usuario after insert on auth.users
  for each row execute function public.crear_categorias_iniciales();
