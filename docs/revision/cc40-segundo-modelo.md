# cc40 — Revisión de segundo modelo (Sonnet, contexto limpio)

- Rama: `feat/cc40-reportes-cierre`
- SHA revisado: `e345ce4d`
- Alcance: `git diff origin/main...HEAD -- apps packages`. No se leyó ningún handoff. Solo lectura de código; este archivo es lo único escrito.
- Pruebas corridas: `jest src/reports` (25 suites, 259 pruebas, verdes) y `vitest run` del web (43 archivos, 294 pruebas, verdes). Los `*.db-spec` no se corrieron (piden base).
- Nota de higiene: el árbol de trabajo tiene `apps/api/src/reports/report-xlsx-totals.db-spec.ts` modificado sin commitear y `docs/uat/cc40.md` sin seguimiento. Lo revisado es lo comprometido en HEAD; si el db-spec modificado debe entrar, hay que commitearlo.

## Resultado

**Sin P0 ni P1.** La corrección de la doble suma es correcta y el agrupado por id también. Hay un P2 y varios P3.

## Lo verificado como correcto

### 1. Doble suma de «Por pedido»

- `salesMarginXlsx` (`apps/api/src/reports/reports-xlsx.ts`): la hoja «Por pedido» lleva solo filas de pedido (`included.map(orderRow)`) y una fila de total. Ninguna fila de comprobante comparte columna con el pedido. La columna «Venta sin IGV» suma una vez cada venta (más la fila de total, como cualquier total al pie).
- El total sale de `summarizeSalesMargin(included)`, la misma función de `report-rows.ts` que usa el pie de la pantalla (`ventas-margen-view.tsx:558-586` y `footerLabel` en `:232`). El rótulo `Total · {salesMarginCountLabel}` es idéntico al de la pantalla.
- Pantalla = Excel = grupos: `included` aplica `filterBySearch(... salesMarginSearchText ...)` y la pantalla filtra con el `searchText` de la columna «Pedido», que es `salesMarginSearchText`. Mismas filas, mismo texto, mismo resumen. En «Ver por» la pantalla filtra antes de agrupar y `groupSalesMargin` suma con `summarizeSalesMargin`. La suma de los grupos es la suma de las filas porque cada pedido cae en exactamente un grupo.
- La pantalla «Por pedido» no cuenta doble: la fila lleva `salesPen` del pedido; el detalle de comprobantes solo se abre con la flecha (`OrderDetail`, `:609`) y no entra en ningún pie. La franja usa los totales del API.
- Panel de administración (`admin-dashboard.ts:34-37`): `salesByDay` recorre `orders -> documents` y suma solo `doc.salesPen`. No suma el pedido y sus comprobantes juntos; no hay doble conteo.
- Hoja «Comprobantes»: `o.salesPen` es la suma de `docSalesInView` de `viewDocs` (service) y cada documento lleva el mismo `docSalesInView`. Los comprobantes de un pedido suman la venta del pedido en «Todas» y en las pestañas por línea (notas de crédito firmadas por `signedSubtotal`).

### 2. Mapeo de índices de `keepColumns` / `pick`

- `ORDER_COLUMNS` (10 columnas: 0 Pedido, 1 Cliente, 2 Vendedor, 3 Comprobantes, 4 Venta, 5 Costo*, 6 Margen*, 7 Margen %_, 8 Material de OPs (solo Todas), 9 Costo registrado_). Las tres filas que se arman (`orderRow`, total de «Por pedido», total de «Facturación parcial») tienen exactamente 10 elementos en ese orden. `pick` toma por el índice original, así que quitar columnas no corre nada.
  - Todas: las 10. Pestaña de línea con costo: sin la 8. Servicios (`noCost`): sin 5, 6, 7, 8 y 9... (la 8 sale por `allOnly` al haber línea; las 5, 6, 7 y 9 por `cost`). Verificado contra las banderas de cada columna.
- `DOCUMENT_COLUMNS` (10 columnas: 0 Pedido, 1 Cliente, 2 Comprobante, 3 Tipo, 4 Emisión, 5 Venta, 6 Costo*, 7 Margen*, 8 Margen %*, 9 Hoja del pedido). Las filas de `documentRows` y de `documentTotal` tienen 10 elementos en ese orden. En Servicios se quitan 6, 7 y 8 y Emisión y Hoja quedan en su sitio.
- `row[c.i] ?? null` conserva `''`; solo cubre `undefined`.

### 3. Agrupar por id

- `groupSalesMargin` usa `customerId` y `sellerId`. Dos clientes con el mismo nombre ya no se mezclan; un cliente no se parte (un id, un grupo). El vendedor nulo cae en la clave `''` con rótulo «Sin vendedor» y no choca con ningún uuid.
- `rowKey = g:${key}` es único por grupo. Las ventas directas (sin pedido) tienen `sellerId` null y van a «Sin vendedor», como antes.
- `customerSearchHref` codifica el RUC/DNI con `encodeURIComponent`.

### 4. Búsqueda en el Excel (siete reportes)

- Las funciones de texto buscable viven en `@ayr/shared` y las usan la pantalla y el API. Se comprobó columna por columna que no se perdió ningún `searchText`: Bobinas (código, tipo, color, acabado, estado), Merma (código, tipo, color, acabado, OPs, estado), Producción por orden y por pedido (el rótulo sin pedido pasó de «A stock» a «Sin pedido (a stock)»; «stock» sigue encontrándolo), Ventas por material y por producto, Inventario, Cuentas por cobrar.
- Totales recalculados con las mismas funciones del pie de la pantalla (`wasteTotalsOf`, `productionTotalsOf`, `agingTotalsOf`, `coilMonthTotalsOf`, `materialFiguresOf`, `productTotalsOf`). Sin búsqueda se devuelve el DTO tal cual (idéntico al API).
- Enmascarado de costos: `searchCoilMonth` conserva `closingValuePen: null` cuando el DTO original lo traía null (aunque no queden filas); `searchProduction` pone `materialCostPen`/`trimCostPen` en null si `!report.withCosts`, también en los subtotales de grupo recalculados.
- Validación: `reportXlsxSearchSchema` (`search` string, máx. 200) y `productionXlsxSearchSchema` (`ver` enum). Ningún esquema de consulta de los reportes es `.strict()`, así que el segundo `@Query` con su propio esquema no choca con el primero. El texto de búsqueda va en una celda que empieza con «Búsqueda «», no puede arrancar como fórmula.
- Los endpoints JSON solo ganan campos (`customerDocNumber`, `salesOrderId` en no trazable, `finishName` donde el DTO ya lo traía). Las consultas SQL añaden `so."id"` y `cu."doc_number"` sin GROUP BY de por medio.

## Hallazgos

### P2-1. «Facturación parcial» mezcla pedidos de dos secciones de la pantalla y su total no coincide con ninguna cifra de la pantalla

- Dónde: `reports-xlsx.ts`, `excludedOrders = report.orders.filter((o) => !o.inTotals)` y el `Total · …` de la hoja «Facturación parcial».
- Escenario: en «Todas», la pantalla separa los pedidos fuera de totales en dos secciones: «Facturación parcial» (`NO_COMPARABLE`) y «Costo no rastreable» (`NO_RASTREABLE`), cada una con su cifra «venta excluida», que además descuenta la parte de Servicios (`sales.minus(noCost)`). El Excel mete ambos grupos en la hoja «Facturación parcial» (ya era así) y ahora añade una fila de total con `summarizeSalesMargin(excludedOrders).sales`, que suma ambos grupos e incluye la venta de Servicios. Quien lo compare con «venta excluida» de la pantalla (o con `Venta fuera de los totales` + `Venta con costo no rastreable` de «Totales») verá un número distinto sin explicación.
- Arreglo sugerido: dividir en dos hojas como la pantalla (o poner un total por `costStatus`), o quitar el total de esa hoja, o añadir una nota al pie que diga que el total incluye Servicios y los dos estados. Como mínimo, la nota.

### P3-1. La hoja «Totales» sigue con el patrón de suma doble que se arregló en «Por pedido»

- Dónde: `reports-xlsx.ts`, hoja «Totales» en «Todas»: filas por línea, `Redondeo`, `Total del rango` y `Sin costo registrado` están en la misma columna «Venta sin IGV». Sumar la columna da más del doble. Preexistente; la nota nueva al pie explica el desacuerdo con «Por pedido», no esta suma.
- Sugerencia: aclarar en la nota que «Total del rango» ya contiene las filas de arriba.

### P3-2. «Comprobantes» lleva en una columna los de «Por pedido» y los de «Facturación parcial», más dos filas de total

- Dónde: `documentsSheet.rows`. Sumar la columna «Venta sin IGV» da comprobantes de ambas hojas más dos totales. No hay doble conteo de una misma venta entre pedidos, pero sí entre filas y totales; la columna «Hoja del pedido» es el único hilo para separarlos. Aceptable por diseño; conviene decirlo en la ayuda o dejar los totales aparte.

### P3-3. Con búsqueda que deja todas las filas, el total de producción no es el del API

- Dónde: `report-xlsx-search.ts`, `searchProduction`: `unattributedKg: '0'`. Con la pantalla, cuando la búsqueda no recorta nada (`allRows`) se muestran los totales del API, incluido «más X kg sin reporte de planta»; el Excel recalcula y pone 0. `productionSummaryXlsx` no imprime `unattributedKg`, así que no se ve en el archivo. Sin efecto práctico hoy.

### P3-4. Enlace de cliente por RUC/DNI usa `contains`

- Dónde: `customerSearchHref` + `customers.service.ts:75` (`docNumber contains`). Un DNI de 8 dígitos puede aparecer dentro de un RUC de 11 y un cliente genérico (p. ej. «00000000») traerá varios. No existe `/clientes/[id]`; aceptable, pero la ficha puede mostrar más de un cliente.

### P3-5. El cliente de una fila sale del primer comprobante del pedido

- Dónde: `sales-margin.service.ts` (`customerId: first.customer_id`). Si los comprobantes de un mismo pedido se emitieron a clientes distintos, la fila (y el grupo «Cliente») toma el del primero. Ya era así con el nombre. Sin acción de cc40.

### P3-6. El Panel cuenta días con todos los comprobantes del rango, incluidos los de pedidos fuera de totales

- Dónde: `admin-dashboard.ts:34-37`. `salesByDay` suma los comprobantes de todos los pedidos, también los `!inTotals`, mientras `sales.salesPen` excluye la parte sin costo comparable. Preexistente y no es doble conteo; el Panel no repite el patrón del Excel.

## Resumen de cobertura

| Pregunta                                                                                 | Veredicto                                                 |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| ¿Alguna columna del Excel suma pedido y comprobantes juntos?                             | No.                                                       |
| Total de «Por pedido» = pie de pantalla = suma de grupos Vendedor/Cliente (mismo filtro) | Sí, misma función y mismas filas.                         |
| Mapeo `keepColumns`/`pick` en Todas, línea y Servicios                                   | Correcto (10 índices por tabla comprobados).              |
| Agrupar por id: fusión/partición indebida, vendedor nulo                                 | No fusiona ni parte; nulo va a «Sin vendedor».            |
| Pantalla «Por pedido» con doble conteo                                                   | No.                                                       |
| Panel con el mismo patrón                                                                | No.                                                       |
| Paridad de búsqueda web/API                                                              | Sí; sin `searchText` perdido.                             |
| Totales recalculados vs pie                                                              | Iguales (mismas funciones).                               |
| Enmascarado de costos                                                                    | Conservado (bobinas por mes, producción).                 |
| Validación de la consulta                                                                | Correcta; ningún esquema estricto rechaza `search`/`ver`. |
| JSON de los endpoints                                                                    | Solo aditivo.                                             |
