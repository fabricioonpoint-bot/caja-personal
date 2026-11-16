-- Widget de iPhone (Scriptable): resumen de solo lectura de la cuenta.
-- Usa la misma clave personal del atajo. No modifica movimientos: solo devuelve
-- el saldo de la caja, las entradas y salidas del mes en curso (hora de Lima)
-- y los últimos movimientos que afectaron la caja.
create or replace function public.resumen_atajo(p_clave text, p_ultimos integer default 5)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := public._usuario_de_clave(p_clave);
  v_hoy date := (now() at time zone 'America/Lima')::date;
  v_mes text := to_char(v_hoy, 'YYYY-MM');
  v_n integer := least(greatest(coalesce(p_ultimos, 5), 0), 10);
  v_saldo numeric(12,2);
  v_entradas numeric(12,2);
  v_salidas numeric(12,2);
  v_total bigint;
  v_ultimos json;
begin
  select coalesce(sum(m.efecto_caja), 0),
         coalesce(sum(m.efecto_caja) filter (where m.efecto_caja > 0 and to_char(m.fecha, 'YYYY-MM') = v_mes), 0),
         coalesce(-sum(m.efecto_caja) filter (where m.efecto_caja < 0 and to_char(m.fecha, 'YYYY-MM') = v_mes), 0),
         count(*)
    into v_saldo, v_entradas, v_salidas, v_total
    from public.movimientos m
   where m.user_id = v_uid;

  select coalesce(json_agg(json_build_object(
           'fecha', u.fecha, 'descripcion', u.descripcion, 'categoria', u.categoria, 'monto', u.efecto_caja)
           order by u.fecha desc, u.created_at desc), '[]'::json)
    into v_ultimos
    from (select m.fecha, m.created_at, m.categoria, m.efecto_caja,
                 coalesce(nullif(trim(m.descripcion), ''), m.categoria) as descripcion
            from public.movimientos m
           where m.user_id = v_uid and m.efecto_caja <> 0
           order by m.fecha desc, m.created_at desc
           limit v_n) u;

  return json_build_object(
    'ok', true, 'saldo', v_saldo, 'mes', v_mes,
    'entradas_mes', v_entradas, 'salidas_mes', v_salidas,
    'movimientos', v_total, 'ultimos', v_ultimos, 'actualizado', now());
end; $$;
revoke execute on function public.resumen_atajo(text, integer) from public;
grant execute on function public.resumen_atajo(text, integer) to anon, authenticated;
