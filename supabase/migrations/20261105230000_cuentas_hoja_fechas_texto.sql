-- Registro de cuentas: fechas como texto para que Google Sheets (en español) no las convierta en números.
drop function public.cuentas_hoja(text);
create function public.cuentas_hoja(p_clave text)
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
  -- Fechas como texto con " h" / "del" para que Google Sheets no las convierta en números
  return query
  select coalesce(u.raw_user_meta_data->>'nombre', '')::text,
         u.email::text,
         to_char(u.created_at at time zone 'America/Lima', 'DD/MM/YYYY') || ' ' || to_char(u.created_at at time zone 'America/Lima', 'HH24:MI') || ' h',
         case when u.email_confirmed_at is null then 'No' else 'Sí' end,
         coalesce(to_char(u.last_sign_in_at at time zone 'America/Lima', 'DD/MM/YYYY') || ' ' || to_char(u.last_sign_in_at at time zone 'America/Lima', 'HH24:MI') || ' h', 'Nunca'),
         count(m.id),
         coalesce(sum(m.monto) filter (where m.tipo = 'Ingreso'), 0),
         coalesce(sum(m.monto) filter (where m.tipo = 'Gasto'), 0),
         coalesce(sum(case when m.tipo = 'Ingreso' then m.monto else -m.monto end), 0),
         coalesce('del ' || to_char(max(m.fecha), 'DD/MM/YYYY'), 'Sin movimientos'),
         case when exists (select 1 from public.claves_atajo k where k.user_id = u.id) then 'Sí' else 'No' end
    from auth.users u
    left join public.movimientos m on m.user_id = u.id
   group by u.id
   order by u.created_at;
end; $$;
revoke execute on function public.cuentas_hoja(text) from public, anon, authenticated;
grant execute on function public.cuentas_hoja(text) to service_role;
