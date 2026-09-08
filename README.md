# Fondeando AURA

Control de estudiantes y caja para una fiesta. El RUT identifica un registro único y cada estudiante puede tener un máximo de **3 tragos con alcohol**. Los datos se guardan en Supabase; todos los dispositivos del equipo deben conectarse al mismo proyecto.

## Estado de la integración

La aplicación ya tiene configuradas la URL y la clave pública del proyecto `nxqtqddsvohpnmvitncr` en `.env`. La conexión al proyecto fue verificada. Falta ejecutar el SQL en Supabase para comenzar a guardar registros. No hay registros ficticios activos y no se necesita iniciar sesión.

## Preparar Supabase

1. En tu proyecto, abre **SQL Editor** y ejecuta una vez `supabase/migrations/202609080001_fiestas.sql`. El script crea tablas con prefijo `fiestas_`, funciones, permisos y sincronización. No borra tablas existentes.
2. La **Project URL** y la clave pública **publishable** ya están en `.env`. El proceso de compilación genera `dist/config.js`; no edites ese archivo generado.
3. Abre la aplicación en dos dispositivos. Registra un estudiante y comprueba que aparezca en el otro dentro de tres segundos.

Nunca pongas `service_role`, `sb_secret_...` ni una contraseña de base de datos en `.env`. La aplicación acepta únicamente una clave pública. `public-config.json` contiene la URL y la clave publishable que el navegador necesita, y puede versionarse porque ambos valores siempre son visibles en una aplicación web. Como decidiste usarla sin cuentas, toda persona que pueda abrir la aplicación publicada podrá consultar RUT, operar consumos y registrar ventas; mantén privada la URL de la aplicación.

Documentación utilizada: [funciones SQL](https://supabase.com/docs/guides/database/functions), [seguridad por fila](https://supabase.com/docs/guides/database/postgres/row-level-security) y [cambios en tiempo real](https://supabase.com/docs/guides/realtime/postgres-changes).

## Ejecutar

Usa Node.js 22 o superior:

```powershell
npm install
npm start
```

Abre `http://127.0.0.1:8080`. `npm start` compila antes de servir la aplicación. No abras `index.html` directamente.

Para preparar el sitio para alojamiento estático HTTPS:

```powershell
npm run build
```

Publica el contenido de `dist/` en el alojamiento que elijas. El servidor local solo sirve la aplicación; la base de datos permanece en Supabase. La aplicación no se ha publicado automáticamente.

## Atención y caja

- **Control de tragos:** escribe el RUT. Si existe, muestra el nombre, carrera y conteo. Si no existe, solicita nombre y carrera. Puedes registrar con el primer trago o solo registrar, comenzando en cero, para cobrar después en caja.
- **Ventas y caja:** selecciona los productos y el medio de pago. Las promociones se calculan automáticamente. Una venta de alimentos o bebidas sin alcohol no requiere un estudiante.
- **Venta con alcohol:** requiere un RUT registrado. Al confirmar, el cobro y el consumo se guardan juntos. La comanda corresponde a un estudiante; dos vasos de una promoción cuentan como dos tragos. Para vender a dos estudiantes, crea una comanda por estudiante.
- **Evitar duplicados:** si cobras en caja, no sumes el mismo trago también en Control de tragos. El registro manual sirve para consumos que no se cobran mediante esta caja; no genera recaudación.
- **Al llegar a tres:** aparece una alerta y se bloquea agregar o vender más. La base de datos comprueba el cupo bajo un bloqueo de fila, aunque otra caja esté atendiendo al mismo estudiante.
- **Conexión interrumpida:** las operaciones quedan pausadas. Si no se pudo confirmar un guardado, usa “Reintentar guardado”; se conserva el identificador de la operación en la pestaña para evitar duplicar el cobro o consumo. Resuelve un guardado pendiente antes de cerrar esa pestaña.
- **Recaudación:** muestra todas las ventas confirmadas de esta fiesta, el desglose por medio de pago y las últimas 50 ventas. La cifra representa ingresos, sin descontar costos.

No hay botones para borrar consumos, reiniciar la fiesta o vaciar las ventas durante la atención. El esquema corresponde a una sola fiesta y conserva el historial de consumos. No implementa pagos en línea: el medio de pago registra cómo se recibió el dinero.

## Catálogo tomado de los afiches

| Producto | Precio | Promoción | Cuenta como trago |
|---|---:|---:|---|
| Empanada de pino | $2.800 | — | No |
| Empanada de queso | $2.500 | — | No |
| Mote con huesillo | $2.500 | — | No |
| Choripán | $2.000 | — | No |
| Anticucho | $4.000 | 2 por $7.000 | No |
| Terremoto | $4.000 | 2 por $7.000 | Sí |
| Bebida (vaso) | $2.000 | — | No |

El producto se muestra como “Terremoto” y cada unidad utiliza uno de los tres cupos del estudiante.

Los precios de una venta se calculan en Supabase, desde `fiestas_products`, y se guardan en el historial. Modificar un precio posteriormente no cambia ventas anteriores.

## Datos de la versión anterior

La versión anterior guardaba estudiantes y ventas en el navegador y cargaba datos de prueba. Esos datos no se borran ni se importan automáticamente en Supabase. Si existen, la aplicación ofrece descargar un respaldo JSON para revisar y migrar los registros reales, separándolos de las pruebas. No reinicies los conteos de una fiesta en curso al cambiar de sistema.

## Verificar

```powershell
npm test
npm run build
```

Las pruebas ejecutan la migración y las funciones SQL en PostgreSQL mediante PGlite: validación y unicidad de RUT, registro, límite, reintentos, promociones, ventas atómicas, totales históricos y permisos. Son pruebas locales; la concurrencia entre conexiones reales y la entrega de eventos Realtime deben comprobarse en el proyecto de Supabase una vez conectado.

