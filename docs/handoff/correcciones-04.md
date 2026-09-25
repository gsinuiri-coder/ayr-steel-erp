# Handoff — Correcciones 04 del cliente, 2026-09-25

Rama `fix/correcciones-04` (worktree `../ayr-steel-erp-corr04`), desde `origin/main` en `86d8db0`.
Decisiones **D-320 a D-327** (`docs/ARQUITECTURA.md` §0.2); D-328 y D-329 quedan para la tanda B.
Texto del cliente: `docs/cliente/correcciones-04.md`. Estado de partida en producción: API
`ayr-steel-erp-api-00055-8cs` (git-sha `fbd2c04`).

Hay **dos tandas con deploy propio**. Este documento cubre la **A** (sin migración); la **B** (film de
protección, reporte mensual en dos tablas y pool de conexiones) se agrega abajo cuando corra.

## Tanda A

### 1. Qué entró

| Milestone | Decisión | Resumen                                                                                                                                                                   |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0.1      | D-321    | «Desde» y «Hasta» del kardex escritos seguidos no se pisan (`kardexCustomPatch`).                                                                                         |
| M0.2      | D-320    | Agregar ítems a un pedido confirmado aplica «bobina atada a otro documento vivo» (D-310).                                                                                 |
| M0.3      | D-322    | Duplicar una cotización con una bobina entera atada crea la copia con la línea `BOB…` sin bobina y un aviso (`warnings[]` + aviso permanente en el detalle).              |
| M1        | D-323    | Se retiran los filtros por columna; los encabezados reordenan. Orden del servidor (`sort`/`dir`) en los 7 listados paginados; `sortRows` en las demás. Reemplaza a D-295. |
| M2        | D-324    | Historial de `/planta`: «Bobinas usadas» con dos códigos y «+N» en un popover; la página no se ensancha.                                                                  |
| M3        | D-325    | Se saca «Bobinas montadas» del detalle de la orden. PASO 0: la sección no tenía acciones; todo lo que se opera vive en `/planta`.                                         |
| M4        | D-326    | Menú por tarea: Comercial, Compras, Almacén, Planta, Catálogo, Reportes, Administración. Enmienda a D-175.                                                                |
| M5        | D-327    | `RowActions`: una principal y «⋯» en las tablas con varias acciones por fila.                                                                                             |

### 2. Censo de tablas (M1)

«Orden» dice **cómo** ordena hoy. **S** = el servidor ordena todo el listado; **T** = ordena todas las
filas ya cargadas (la tabla no pagina); **P** = solo las filas de la página (columna derivada, lo dice
el `title` del encabezado).

| Vista                                | Pagina   | Orden hoy → columnas                                                                      |
| ------------------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| Cotizaciones                         | servidor | **S** código, cliente, emisión, total, estado                                             |
| Pedidos                              | servidor | **S** código, cliente, fecha, total · **P** estado mostrado                               |
| Bobinas                              | servidor | **S** código, estado · **P** disponible                                                   |
| Clientes                             | servidor | **S** documento, nombre, días de crédito, estado                                          |
| Compras                              | servidor | **S** comprobante, proveedor, tipo, emisión, vence, total, estado (el saldo no: derivado) |
| Comprobantes                         | servidor | **S** número, tipo, cliente, emisión, vencimiento, total, estado (el saldo no: derivado)  |
| Despachos                            | servidor | **S** código, pedido, cliente, fecha, peso, estado                                        |
| Historial de órdenes (`/planta`)     | cliente  | **T** pedido, cliente, fecha, cerradas, metros, estado                                    |
| Catálogo (por línea)                 | no       | **T** SKU, nombre, unidad, estado, precio                                                 |
| Colores                              | no       | **T** código, color, estado                                                               |
| Acabados                             | no       | **T** código, nombre, línea, tipo, color, densidad, estado                                |
| Proveedores                          | no       | **T** código, documento, nombre, corte, crédito, estado                                   |
| Usuarios                             | no       | **T** nombre, correo, rol, estado                                                         |
| Flejes (stock)                       | no       | **T** acabado, espesor, ancho, stock, costo, valorizado, bobinas                          |
| Corte tercerizado                    | no       | **T** proveedor, línea, bobinas, enviada, estado                                          |
| Reservas temporales                  | no       | **T** cotización, cliente, vence                                                          |
| Cobranzas (por cliente y pendientes) | no       | **T** dos tablas con prefijos `r` y `p` en la URL                                         |
| Estado de cuenta del proveedor       | no       | **T** comprobante, línea, tipo, emisión, vence, total, saldo, saldo en soles, antigüedad  |
| Tipo de cambio                       | no       | **T** fecha, moneda, compra, venta, origen                                                |
| Reporte de bobinas                   | no       | **T** todas las columnas (se rehace en la tanda B)                                        |
| Kardex de un ítem                    | no       | **T** solo fecha (el saldo corrido se lee en orden)                                       |
| Órdenes de un pedido                 | no       | **T** orden, producto, estado                                                             |

**No ordenan, y por qué:** auditoría (bitácora cronológica, filtra por fecha y usuario), inventario y
inventario valorizado y ventas y margen (reportes con totales y filas agrupadas o expandibles), líneas
y márgenes (pocas filas, editables), importar precios (vista previa), las líneas de un documento
(cotización, pedido, comprobante, despacho), cobros y notas de crédito, reportes de piezas, los
buscadores y selectores de un formulario y el carrito del mostrador.

### 3. Tablas con acciones por fila (M5)

Con `RowActions`: catálogo (Editar · Receta · Desactivar), acabados, colores, clientes, proveedores
(Estado de cuenta · Editar · Desactivar), usuarios, líneas del pedido (Precio · Cantidad · Bobina) y
filas de borrador de reportes de `/planta` (Corregir · **Quitar**, destructiva). **Sin cambio (una sola
acción):** cobros de un comprobante (Revertir), órdenes de un pedido (Producir), márgenes.

### 4. Mapa del menú (M4)

Antes → ahora, sin cambiar rutas. Comercial: Mostrador, Clientes, Cotizaciones, Reservas temporales,
Pedidos, Comprobantes, Despachos, Cobranzas → **Cotizaciones, Reservas temporales, Pedidos, Despachos,
Comprobantes, Cobranzas, Mostrador, Clientes**. Catálogo (antes con Inventario, Kardex y Flejes) →
**Productos, Líneas, Acabados, Colores**. Planta (antes con Bobinas, Compras, Corte, Proveedores,
Reporte de bobinas) → **Producción, Órdenes de producción**. Nuevos: **Compras** (Compras, Proveedores),
**Almacén** (Bobinas, Flejes, Corte tercerizado, Inventario, Kardex) y **Reportes** (Ventas y margen,
Inventario valorizado, Reporte mensual de bobinas). Administración → **Usuarios, Márgenes y tipo de
cambio, Auditoría, Configuración**. Ubicado con criterio (el mapa no lo nombraba): **Reservas
temporales**, en Comercial. «Configuración» apunta a `/configuracion/reservas` (la tercera pestaña de
esa pantalla), la única ruta de configuración que el mapa no cubría con «Márgenes y tipo de cambio».

### 5. Verificación

(Se completa al cerrar la tanda; ver `docs/PROGRESO.md`.)

### 6. Para el dueño

1. **Las imágenes del cliente no llegaron a `local-data/corr04/`.** M2 y M4 se hicieron con el texto y
   el mapa; conviene mirarlas contra lo entregado.
2. **Duplicar con bobina atada** deja una cotización **emitida y con PDF** que tiene una línea sin
   bobina y no se puede confirmar (D-322). Alternativa si molesta: crearla en borrador.
3. **El aviso de D-322 no dice «Convertir en venta de bobina»** (solo existe para importadas): dice
   «Bobina completa (venta directa)».
4. **Puerto 3000:** hay un `nuxt dev` de otro proyecto en `[::1]:3000` (no es de este repo). Los E2E
   locales corrieron con `E2E_API_PORT=3010`.
