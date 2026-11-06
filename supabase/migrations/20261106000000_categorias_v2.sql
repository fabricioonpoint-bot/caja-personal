-- Categorías v2
-- Gasto:   Yape a terceros + Depósitos a terceros -> "Depósitos / Yape a terceros"
--          "Efectivo entregado" (a tu propia cuenta) -> "Efectivo para mí"
--          Material de trabajo pasa a ser categoría propia (antes en "Otros gastos")
-- Ingreso: "Depósito Yape" -> "Depósitos / Yape recibidos"
--          "Depósito en cajero" -> "Depósito a cuenta FAB"

-- 1) Movimientos existentes
update public.movimientos set categoria = 'Depósitos / Yape a terceros'
  where tipo = 'Gasto' and categoria in ('Yape a terceros', 'Depósitos a terceros');

update public.movimientos set categoria = 'Efectivo para mí'
  where tipo = 'Gasto' and categoria = 'Efectivo a terceros'
    and persona is null and descripcion ilike '%entregado%';

update public.movimientos set categoria = 'Material de trabajo', subcategoria = 'Herramientas'
  where tipo = 'Gasto' and categoria = 'Otros gastos'
    and (descripcion ilike '%material%' or subcategoria = 'Material de trabajo');

update public.movimientos set categoria = 'Depósitos / Yape recibidos'
  where tipo = 'Ingreso' and categoria = 'Depósito Yape';

update public.movimientos set categoria = 'Depósito a cuenta FAB'
  where tipo = 'Ingreso' and categoria = 'Depósito en cajero';

-- 2) Categorías de cada usuario
update public.categorias set nombre = 'Depósitos / Yape a terceros'
  where tipo = 'Gasto' and nombre = 'Depósitos a terceros';
delete from public.categorias where tipo = 'Gasto' and nombre = 'Yape a terceros';
update public.categorias set nombre = 'Depósitos / Yape recibidos'
  where tipo = 'Ingreso' and nombre = 'Depósito Yape';
update public.categorias set nombre = 'Depósito a cuenta FAB'
  where tipo = 'Ingreso' and nombre = 'Depósito en cajero';

insert into public.categorias (user_id, tipo, nombre)
select u.user_id, 'Gasto', n.nombre
from (select distinct user_id from public.categorias) u
cross join (values ('Material de trabajo'), ('Efectivo para mí')) as n(nombre)
on conflict (user_id, tipo, nombre) do nothing;

-- 3) Categorías iniciales para usuarios nuevos
create or replace function public.crear_categorias_iniciales()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.categorias (user_id, tipo, nombre)
  select new.id, c.tipo, c.nombre from (values
    ('Ingreso','Efectivo recibido'),('Ingreso','Depósitos / Yape recibidos'),('Ingreso','Depósito a cuenta FAB'),
    ('Ingreso','Pago recibido'),('Ingreso','Transferencia recibida'),
    ('Gasto','Alimentos'),('Gasto','Compras personales'),('Gasto','Material de trabajo'),
    ('Gasto','Depósitos / Yape a terceros'),('Gasto','Efectivo a terceros'),('Gasto','Efectivo para mí'),
    ('Gasto','Transferencia a mi cuenta'),('Gasto','Otros gastos')
  ) as c(tipo, nombre);
  return new;
end; $$;
revoke execute on function public.crear_categorias_iniciales() from public, anon, authenticated;
