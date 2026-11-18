# Caja Personal

Control de ingresos y gastos personales, con cuenta propia para cada usuario. Funciona en computadora y en teléfono (pensado para iPhone 15 Pro Max).

## Qué hace

- Registro e inicio de sesión con correo y contraseña. Cada usuario ve solo sus movimientos.
- Contraseña segura al crear la cuenta: 8 caracteres o más con letras y números (lo exige también Supabase), se escribe dos veces y muestra su fuerza. Se guarda cifrada; nadie puede verla.
- **Registro de cuentas en Google Sheets:** la hoja "Caja Personal – Registro de cuentas" importa sola (`IMPORTDATA`) nombre, correo, fechas, movimientos y saldo de cada cuenta, sin contraseñas. Usa la función web `cuentas-hoja`, protegida con una clave que va en la celda B1.
- **Resumen:** saldo disponible, entradas, salidas, gasto real (sin transferencias a la propia cuenta ni efectivo para uno mismo), gastos por categoría, entradas por origen y comparación mensual de entradas vs. salidas.
- **Compartir mi cuenta:** el dueño da acceso a otra persona por su correo (solo ver, o ver y registrar) y puede quitarlo cuando quiera. Quien recibe el acceso elige la cuenta en "Viendo la cuenta de".
- **Quién registró:** cada movimiento guarda quién lo registró (`registrado_por`, `registrado_nombre`) y por dónde (web, atajo, hoja).
- **Movimientos:** lista completa con filtros por tipo, categoría, mes y búsqueda.
- **Nuevo movimiento:** tipo, monto, categoría, subcategoría, descripción, persona, medio y fecha (automática).
- **Modelo administrado:** el administrador crea cada cuenta desde la sección **Cuentas** con el nombre, correo y contraseña que le entrega a la persona. No hay registro público.
- **Hoja de Google por persona, en doble vía:** se copia la "Caja Personal – Plantilla", se conecta con la clave de hoja de esa persona, y lo que se escribe o corrige en la hoja pasa al instante a la plataforma, y lo que se registra, borra o cambia en la plataforma aparece en la hoja en menos de un minuto. La hoja muestra también **Registrado por**, **Registrado el** y **Última modificación** (fecha y quién: una persona o "Hoja de cálculo"). El script está en `google-sheets/CajaPersonal.gs`; en una hoja ya conectada, se actualiza con el menú **Caja Personal → Actualizar la conexión a la versión nueva**.
- **Control general (hoja completa de finanzas):** una cuenta puede sincronizar en doble vía con la pestaña MOVIMIENTOS de la hoja "Control general de gastos personales" (auto, ventas, gastos personales, tarjetas, préstamos). La plataforma muestra la **caja personal** con la misma regla de la hoja: auto (ingresos − gastos) + utilidad de ventas + otros ingresos − gastos personales; los abonos a tarjetas, cuotas de deuda y préstamos se registran pero no cuentan. Desde la plataforma se puede registrar, **editar** y eliminar cualquier movimiento, con su ámbito, estado, cuenta, costo y nota. El script está en `google-sheets/ControlGeneral.gs` (ver "Conectar la hoja de control general").
- **Panel por actividades:** cada cuenta tiene sus actividades (Taxi, Ventas, Obra y siempre Personal). El resumen muestra una tarjeta por actividad con su resultado del mes (Taxi: días trabajados, promedio por día y plataformas; Ventas: vendido, costo, utilidad y margen; Personal: otros ingresos, gastos y presupuesto) y la caja personal como suma. Las actividades salen de `plantillas_usuario` (se eligen al crear la cuenta) y del ámbito de cada movimiento (Auto → Taxi, Ventas/Negocio → Ventas, Obra → Obra, el resto → Personal). "Ver con datos de ejemplo" muestra una taxista que también vende ropa.
- **Presupuesto y pagos fijos desde la hoja:** el conector envía la pestaña PRESUPUESTO (límites por grupo y mes, y qué categoría va a cada grupo) y PAGOS FIJOS (servicios FIJO-…) a `cuenta_config`. La web muestra el semáforo del mes (verde ≤ 80 %, amarillo ≤ 100 %, rojo) y qué fijos están pagados, pendientes o vencidos (un fijo está pagado si hay un gasto con su `ID recurrente`).
- **Siempre al día:** la web consulta `estado_cuenta` cada 45 s y recarga sola cuando algo cambió (hoja, atajo u otra persona). Arriba del resumen avisa si la hoja está sincronizada, desde cuándo no sincroniza, o si faltan filas con error.
- **Atajo iPhone:** cada usuario genera una clave personal y arma el atajo "Gastos e Ingresos" siguiendo los pasos de la pantalla. El atajo guarda directo en su cuenta (origen `atajo`) y responde con el saldo.

## Estructura

```
index.html                          La plataforma completa (HTML, CSS y JS en un archivo)
supabase/migrations/*.sql           Tablas, seguridad por usuario, atajo, hojas y administración
supabase/functions/admin            Crear cuentas, cambiar contraseñas, claves de hoja (solo administrador)
supabase/functions/cuentas-hoja     Registro de cuentas en CSV para Google Sheets
google-sheets/CajaPersonal.gs       Script de la hoja plantilla (sincronización en doble vía)
google-sheets/ControlGeneral.gs     Script para la hoja "Control general de gastos personales" (pestaña MOVIMIENTOS)
```

## Base de datos (Supabase)

Proyecto `control-finanzas` (región sa-east-1).

| Tabla | Contenido |
|---|---|
| `movimientos` | fecha, tipo (Ingreso/Gasto), categoría, subcategoría, descripción, persona, medio, monto, origen (web, atajo, foto, importado) |
| `categorias` | categorías de cada usuario; se crean automáticamente al registrarse |
| `claves_atajo` | una clave por usuario para el atajo de iPhone; solo se guarda su hash (sha256) |
| `accesos` | a quién le compartió cada dueño su cuenta (correo) y si puede registrar |
| `movimientos_eliminados` | copia de respaldo de cada movimiento eliminado: qué era, quién lo borró y cuándo (solo lo ve el dueño) |

Las tablas tienen Row Level Security: cada usuario solo puede leer y modificar sus propias filas, más las cuentas que otra persona le compartió en `accesos` (ver; registrar si tiene permiso; borrar solo lo que registró).

### Funciones para el atajo

| Función | Quién la llama | Qué hace |
|---|---|---|
| `generar_clave_atajo()` | la web, con sesión iniciada | crea o reemplaza la clave y la devuelve una sola vez |
| `categorias_atajo(p_clave, p_tipo)` | el atajo | lista las categorías del usuario para el menú |
| `registrar_atajo(p_clave, p_tipo, p_monto, p_categoria, p_descripcion, p_persona, p_medio, p_fecha)` | el atajo | guarda el movimiento y devuelve `{ mensaje, saldo }` |

Las dos últimas se pueden llamar sin iniciar sesión (`POST /rest/v1/rpc/...` con el encabezado `apikey`), pero solo funcionan con una clave válida y solo escriben en la cuenta de su dueño. El aviso de Supabase "Public Can Execute SECURITY DEFINER Function" sobre ellas es esperado.

La clave que aparece en `index.html` es la clave pública (anon) de Supabase. Es seguro publicarla porque el acceso a los datos lo controla Row Level Security.

## Conectar la hoja de control general

1. En la hoja: **Extensiones → Apps Script**, crea un archivo `ControlGeneral` y pega `google-sheets/ControlGeneral.gs`. Las funciones empiezan con `cp` para no chocar con los otros scripts de la hoja.
2. Ejecuta una vez `cpInstalar` y acepta los permisos. Recarga la hoja: aparece el menú **Caja Personal**.
3. En la plataforma, como administrador: **Cuentas → Clave de hoja** de la persona. Cópiala.
4. En la hoja: **Caja Personal → Conectar con la plataforma…** y pega la clave.

Cómo funciona:

- Cada movimiento se empareja por su **ID** (columna A). Los creados en la plataforma llevan `CP-…`; las filas escritas a mano sin ID reciben `HOJA-…`.
- El script solo escribe en las columnas de datos de MOVIMIENTOS. No toca las columnas con fórmulas ni las demás pestañas (inventario, ventas, tarjetas siguen en la hoja).
- Hoja → plataforma: al editar, y cada minuto. Plataforma → hoja: cada minuto. Si una fila queda incompleta, el motivo aparece como nota en la celda del ID.
- Primera conexión: gana la hoja, salvo lo que se cambió o eliminó directamente en la plataforma.
- Borrar una fila en la hoja la elimina en la plataforma (queda copia en `movimientos_eliminados`). Si desaparecen más de 20 filas de golpe, no se borra nada.
- La pestaña oculta `_CP_SYNC` guarda la huella de lo ya sincronizado; no hay que tocarla.

Versión 2 del conector: además envía PRESUPUESTO y PAGOS FIJOS (`cg_config`) cuando cambian, y al abrir la hoja reinstala sus disparadores si se perdieron. Para actualizar una hoja ya conectada basta con reemplazar el código de `ControlGeneral` y recargar la hoja.

El conector tiene dos ganchos opcionales para otros scripts de la misma hoja: `cpAlRecibir(tipo, ref)` por cada fila que llega o se quita desde la plataforma, y `cpDespuesDeRecibir(res)` al terminar si llegó algo. Si no existen, no pasa nada.

### Apuntes del auto en doble vía (hoja de Fabricio)

`google-sheets/AutoDobleVia.gs` va en el proyecto de la hoja de control general de Fabricio, junto a su `Código.gs` (que ya llevaba "Apuntes de ingresos y gastos de Auto" → MOVIMIENTOS como filas `AP-AUTO-2026MMDD-I1…I4 / G1…G7`, una por celda). Agrega el camino de vuelta:

- Un ingreso o gasto del taxi registrado en la plataforma (o escrito a mano en MOVIMIENTOS con ámbito Auto, agosto–diciembre 2026) se suma en su celda de la pestaña del mes en los apuntes: ID/InDrive → ID, UBER, CAB/Cabify, el resto → Otros ingresos (con el nombre en Notas); Combustible → Gasolina, Mecánico, Arreglos → Mantenimiento, Lavado, Cochera → Parqueo, Seguro, el resto → Otros gastos. Km y horas se suman al día. La fila original se quita y `sincronizarAuto` la vuelve a crear como `AP-AUTO-…`, así no se cuenta dos veces. RESUMEN AUTO y BASE ANUAL AUTO se actualizan con sus fórmulas.
- Si en la plataforma se cambia el monto de una fila `AP-AUTO-…` o se borra, la celda toma ese monto o se vacía.
- Corre dentro de `sincronizarAuto` (cada 5 minutos y al editar los apuntes) y también apenas el conector recibe algo de la plataforma.

Lo que entra por el atajo en una cuenta de control general toma el ámbito de su categoría (categorías de la cuenta o, si no, el ámbito más usado con esa categoría): un ingreso "UBER" va a Auto, no a Personal.

Campos de `movimientos` para estas cuentas: `movimiento`, `tipo_gasto`, `ambito`, `estado`, `cuenta`, `necesidad`, `costo`, `envio`, `es_prueba`, `ref_hoja` (ID de la hoja), `extra` (columnas de apoyo), `cambio_via` y `efecto_caja` (calculado). Funciones de la hoja: `cg_identidad`, `cg_todo`, `cg_cambios`, `cg_guardar`.

## Publicar

1. Sube la carpeta a Netlify, Vercel o GitHub Pages.
2. En Supabase, en **Authentication → URL Configuration**, pon la dirección publicada en **Site URL** para que el correo de confirmación funcione.
3. En el iPhone, abre la dirección en Safari y toca **Compartir → Agregar a inicio**.

## Próximos pasos

- Registro desde foto de recibo (origen `foto`).
