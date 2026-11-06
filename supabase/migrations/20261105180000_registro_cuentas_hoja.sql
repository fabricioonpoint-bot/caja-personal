-- Registro de cuentas para la hoja de cálculo del administrador.
-- Nunca expone contraseñas: Supabase solo guarda su hash y esta función no lo lee.
-- Solo la puede ejecutar el rol de servicio (la función web "cuentas-hoja"), y además exige la clave de la hoja.

create table public.config_privada (
  nombre text primary key,
  valor_hash text not null,
  updated_at timestamptz not null default now()
);
alter table public.config_privada enable row level security;   -- sin políticas: nadie la lee desde la web
revoke all on public.config_privada from anon, authenticated;

create or replace function public.cuentas_hoja(p_clave text)
returns table (
  nombre text, correo text, cuenta_creada text, correo_confirmado text, ultimo_ingreso text,
  movimientos bigint, total_ingresos numeric, total_gastos numeric, saldo numeric,
  ultimo_movimiento date, atajo_iphone text
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
         to_char(u.created_at at time zone 'America/Lima', 'YYYY-MM-DD HH24:MI'),
         case when u.email_confirmed_at is null then 'No' else 'Sí' end,
         coalesce(to_char(u.last_sign_in_at at time zone 'America/Lima', 'YYYY-MM-DD HH24:MI'), ''),
         count(m.id),
         coalesce(sum(m.monto) filter (where m.tipo = 'Ingreso'), 0),
         coalesce(sum(m.monto) filter (where m.tipo = 'Gasto'), 0),
         coalesce(sum(case when m.tipo = 'Ingreso' then m.monto else -m.monto end), 0),
         max(m.fecha),
         case when exists (select 1 from public.claves_atajo k where k.user_id = u.id) then 'Sí' else 'No' end
    from auth.users u
    left join public.movimientos m on m.user_id = u.id
   group by u.id
   order by u.created_at;
end; $$;
revoke execute on function public.cuentas_hoja(text) from public, anon, authenticated;
grant execute on function public.cuentas_hoja(text) to service_role;
