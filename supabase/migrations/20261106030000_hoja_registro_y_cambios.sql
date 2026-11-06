-- Quién registró y quién cambió cada movimiento, visible también en la hoja de cálculo.
-- Lo que se escribe en la hoja no tiene sesión de usuario: se marca como "Hoja de cálculo".

alter table public.movimientos add column if not exists modificado_nombre text;

create or replace function public._marcar_registro()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null and new.origen = 'hoja' then
    new.registrado_por := null;
    new.registrado_nombre := 'Hoja de cálculo';
  else
    v := coalesce(v, new.user_id);
    new.registrado_por := v;
    new.registrado_nombre := (select coalesce(nullif(u.raw_user_meta_data->>'nombre', ''), u.email) from auth.users u where u.id = v);
  end if;
  return new;
end; $$;
revoke execute on function public._marcar_registro() from public, anon, authenticated;

create or replace function public._marcar_cambio()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.modificado_nombre := coalesce(
    (select coalesce(nullif(u.raw_user_meta_data->>'nombre', ''), u.email) from auth.users u where u.id = auth.uid()),
    'Hoja de cálculo');
  return new;
end; $$;
revoke execute on function public._marcar_cambio() from public, anon, authenticated;
drop trigger if exists marcar_cambio on public.movimientos;
create trigger marcar_cambio before update on public.movimientos
  for each row when (old.* is distinct from new.*) execute function public._marcar_cambio();

create or replace function public.hoja_leer(p_clave text)
returns json language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := public._usuario_de_clave_hoja(p_clave);
begin
  return json_build_object(
    'nombre', (select coalesce(raw_user_meta_data->>'nombre', '') from auth.users where id = v_uid),
    'correo', (select email from auth.users where id = v_uid),
    'categorias', (select json_build_object(
        'Ingreso', coalesce(json_agg(nombre order by id) filter (where tipo = 'Ingreso'), '[]'::json),
        'Gasto',   coalesce(json_agg(nombre order by id) filter (where tipo = 'Gasto'), '[]'::json))
      from public.categorias where user_id = v_uid),
    'movimientos', coalesce((select json_agg(json_build_object(
        'id', id, 'fecha', fecha, 'tipo', tipo, 'categoria', categoria, 'subcategoria', subcategoria,
        'descripcion', descripcion, 'persona', persona, 'medio', medio, 'monto', monto, 'origen', origen,
        'registrado_nombre', coalesce(registrado_nombre, ''),
        'registrado_el', to_char(created_at at time zone 'America/Lima', 'DD/MM/YYYY HH24:MI'),
        'modificado', case when modificado_nombre is null then ''
                      else to_char(updated_at at time zone 'America/Lima', 'DD/MM/YYYY HH24:MI') || ' · ' || modificado_nombre end)
        order by fecha desc, created_at desc) from public.movimientos where user_id = v_uid), '[]'::json)
  );
end; $$;
