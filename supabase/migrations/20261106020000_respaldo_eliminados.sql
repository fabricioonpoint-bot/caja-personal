-- Copia de respaldo de cada movimiento eliminado (desde la web, la hoja o cualquier otro lado).
-- El dueño de la cuenta puede verlos; nadie los puede editar ni borrar desde la web.
create table public.movimientos_eliminados (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  datos jsonb not null,
  eliminado_por uuid references auth.users(id) on delete set null,
  eliminado_por_nombre text,
  eliminado_at timestamptz not null default now()
);
create index movimientos_eliminados_user_idx on public.movimientos_eliminados (user_id, eliminado_at desc);
alter table public.movimientos_eliminados enable row level security;
create policy "eliminados: el dueño los ve" on public.movimientos_eliminados for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public._respaldar_eliminado()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid := coalesce(auth.uid(), old.user_id);
begin
  insert into public.movimientos_eliminados (id, user_id, datos, eliminado_por, eliminado_por_nombre)
  values (old.id, old.user_id, to_jsonb(old), v,
          (select coalesce(nullif(u.raw_user_meta_data->>'nombre', ''), u.email) from auth.users u where u.id = v))
  on conflict (id) do nothing;
  return old;
end; $$;
revoke execute on function public._respaldar_eliminado() from public, anon, authenticated;
create trigger respaldar_eliminado after delete on public.movimientos
  for each row execute function public._respaldar_eliminado();
