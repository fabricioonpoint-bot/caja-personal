-- Maestro de obra: obras con presupuesto por metrado, bitácora (notas, preguntas, avances y jornadas)
-- y precios propios del maestro. Los cobros y gastos de cada obra siguen en "movimientos"
-- (ámbito Obra) con extra.obra_id y extra.Obra = nombre de la obra.

create table if not exists public.obras (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nombre text not null check (length(trim(nombre)) > 0),
  cliente text, telefono text, ubicacion text, descripcion text,
  estado text not null default 'En curso' check (estado in ('Presupuesto','En curso','Pausada','Terminada')),
  fecha_inicio date, fecha_fin date,
  precio_acordado numeric(12,2),
  presupuesto jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists obras_user_idx on public.obras(user_id);

create table if not exists public.obra_registros (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obras(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  fecha date not null default current_date,
  tipo text not null default 'Nota' check (tipo in ('Nota','Pregunta','Avance','Jornada')),
  titulo text, texto text,
  horas numeric(6,2) check (horas is null or horas >= 0),
  personas integer check (personas is null or personas >= 0),
  resuelta boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists obra_registros_obra_idx on public.obra_registros(obra_id, fecha);

create table if not exists public.precios_maestro (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  datos jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public._tocar_updated_at() returns trigger
language plpgsql set search_path to '' as $$ begin new.updated_at := now(); return new; end $$;
create or replace trigger obras_updated before update on public.obras for each row execute function public._tocar_updated_at();
create or replace trigger precios_maestro_updated before update on public.precios_maestro for each row execute function public._tocar_updated_at();

-- Un registro de bitácora siempre pertenece al dueño de su obra
create or replace function public._registro_de_su_obra() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  select o.user_id into new.user_id from public.obras o where o.id = new.obra_id;
  if new.user_id is null then raise exception 'La obra no existe'; end if;
  return new;
end $$;
revoke execute on function public._registro_de_su_obra() from public, anon, authenticated;
create or replace trigger obra_registros_dueno before insert or update on public.obra_registros for each row execute function public._registro_de_su_obra();

alter table public.obras enable row level security;
alter table public.obra_registros enable row level security;
alter table public.precios_maestro enable row level security;

-- Dueño: todo. Cuenta compartida: ver; registrar si tiene permiso.
create policy "obras: ver" on public.obras for select to authenticated using ((select auth.uid()) = user_id or public.puede_ver(user_id));
create policy "obras: crear" on public.obras for insert to authenticated with check ((select auth.uid()) = user_id or public.puede_registrar(user_id));
create policy "obras: editar" on public.obras for update to authenticated using ((select auth.uid()) = user_id or public.puede_registrar(user_id)) with check ((select auth.uid()) = user_id or public.puede_registrar(user_id));
create policy "obras: borrar" on public.obras for delete to authenticated using ((select auth.uid()) = user_id);

create policy "obra_registros: ver" on public.obra_registros for select to authenticated using ((select auth.uid()) = user_id or public.puede_ver(user_id));
create policy "obra_registros: crear" on public.obra_registros for insert to authenticated with check ((select auth.uid()) = user_id or public.puede_registrar(user_id));
create policy "obra_registros: editar" on public.obra_registros for update to authenticated using ((select auth.uid()) = user_id or public.puede_registrar(user_id)) with check ((select auth.uid()) = user_id or public.puede_registrar(user_id));
create policy "obra_registros: borrar" on public.obra_registros for delete to authenticated using ((select auth.uid()) = user_id or public.puede_registrar(user_id));

create policy "precios_maestro: ver" on public.precios_maestro for select to authenticated using ((select auth.uid()) = user_id or public.puede_ver(user_id));
create policy "precios_maestro: guardar" on public.precios_maestro for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "precios_maestro: cambiar" on public.precios_maestro for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.obras, public.obra_registros to authenticated;
grant select, insert, update on public.precios_maestro to authenticated;
