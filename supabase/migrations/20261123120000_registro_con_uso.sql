-- Registro abierto con elección de uso (Personal, Taxista, Maestro de obra, Vendedor).
-- 1) Al crearse un usuario con "usos" en sus datos de registro, se le asignan esas plantillas
--    (Personal siempre) en lugar de las categorías genéricas de la v1. Funciona aunque deba
--    confirmar su correo antes de entrar. Sin "usos" (cuentas creadas por el administrador),
--    todo sigue igual que antes.
-- 2) quitar_plantilla: la persona desactiva una actividad. Sus movimientos y categorías se quedan.

create or replace function public.crear_categorias_iniciales()
returns trigger language plpgsql security definer set search_path to '' as $function$
declare v_usos jsonb := new.raw_user_meta_data -> 'usos'; v_p text;
begin
  if v_usos is not null and jsonb_typeof(v_usos) = 'array' then
    begin
      perform public._copiar_plantilla(new.id, 'personal');
      for v_p in select distinct x from jsonb_array_elements_text(v_usos) as x
                  where x in ('taxista','obra','vendedor') loop
        perform public._copiar_plantilla(new.id, v_p);
      end loop;
      return new;
    exception when others then
      -- Nunca impedir el registro: si algo falla, quedan las categorías genéricas
      -- y la web le vuelve a preguntar a qué se dedica.
      null;
    end;
  end if;
  insert into public.categorias (user_id, tipo, nombre)
  select new.id, c.tipo, c.nombre from (values
    ('Ingreso','Efectivo a cuenta'),('Ingreso','Depósitos / Yape a cuenta'),('Ingreso','Depósito a cuenta'),
    ('Ingreso','Pago recibido'),('Ingreso','Transferencia recibida'),
    ('Gasto','Alimentos'),('Gasto','Compras personales'),('Gasto','Material de trabajo'),
    ('Gasto','Depósitos / Yape a terceros'),('Gasto','Efectivo a terceros'),('Gasto','Efectivo para mí'),
    ('Gasto','Transferencia a mi cuenta'),('Gasto','Otros gastos')
  ) as c(tipo, nombre)
  on conflict do nothing;
  return new;
end; $function$;

create or replace function public.quitar_plantilla(p_plantilla text)
returns json language plpgsql security definer set search_path to '' as $function$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Debes iniciar sesión'; end if;
  if p_plantilla = 'personal' then raise exception 'Personal va incluida siempre'; end if;
  if p_plantilla not in ('taxista','obra','vendedor') then raise exception 'Plantilla no válida: %', p_plantilla; end if;
  update public.plantillas_usuario set activa = false where user_id = v_uid and plantilla = p_plantilla;
  return json_build_object('ok', true,
    'plantillas', (select coalesce(json_agg(plantilla order by plantilla), '[]'::json) from public.plantillas_usuario where user_id = v_uid and activa));
end; $function$;

revoke all on function public.quitar_plantilla(text) from public, anon;
grant execute on function public.quitar_plantilla(text) to authenticated;
