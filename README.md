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
- **Atajo iPhone:** cada usuario genera una clave personal y arma el atajo "Gastos e Ingresos" siguiendo los pasos de la pantalla. El atajo guarda directo en su cuenta (origen `atajo`) y responde con el saldo.

## Estructura

```
index.html                          La plataforma completa (HTML, CSS y JS en un archivo)
supabase/migrations/*.sql           Tablas, seguridad por usuario, atajo, hojas y administración
supabase/functions/admin            Crear cuentas, cambiar contraseñas, claves de hoja (solo administrador)
supabase/functions/cuentas-hoja     Registro de cuentas en CSV para Google Sheets
google-sheets/CajaPersonal.gs       Script de la hoja plantilla (sincronización en doble vía)
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

## Publicar

1. Sube la carpeta a Netlify, Vercel o GitHub Pages.
2. En Supabase, en **Authentication → URL Configuration**, pon la dirección publicada en **Site URL** para que el correo de confirmación funcione.
3. En el iPhone, abre la dirección en Safari y toca **Compartir → Agregar a inicio**.

## Próximos pasos

- Registro desde foto de recibo (origen `foto`).
