# cc39 — Revisión de segundo modelo (Sonnet, contexto limpio)

Rama: `feat/cc39-pieza-api` — SHA revisado: `ca726afb`
Diff: `git diff origin/main...HEAD` (44 archivos). Solo lectura; se corrieron los unitarios de la entrega
(`coil-waste-xlsx`, `reports-xlsx`, `sales-by-material-xlsx`, `reports.controller`, `purchase-math`,
`supplier-statement`: 64 pasan) y `report-totals` / `sales-margin-groups` del web (21 pasan). El
`report-xlsx-totals.db-spec.ts` no se corrió (requiere base).

Resultado: **ningún P0 ni P1.** Tres P2/P3 sobre cómo se compara el Excel con el pie de la pantalla y
un puñado de detalles menores.

---

## Hallazgos

### 1. P2 — «Ventas y margen»: la hoja «Por pedido» no tiene fila de total, y el pie de la pantalla no sale en ninguna hoja

`apps/api/src/reports/reports-xlsx.ts:259` (hoja «Por pedido»), `:277` (hoja «Totales»);
pantalla: `ventas-margen-view.tsx:214-230` (`total: summarizeSalesMargin(rows)`).

La pantalla muestra dos juegos de cifras distintos y lo dice en su ayuda: la **franja**
(`data.totals`, que incluye la venta de Servicios de pedidos no comparables y el margen sin la venta sin
costo) y el **pie de la tabla** (`summarizeSalesMargin(included)`, suma de las filas de la tabla). El Excel
escribe solo la franja (hoja «Totales», `report.totals`). Escenario: el dueño abre la pestaña Drywall,
ve al pie «Venta 12 345,00 / Margen 4 100,00», descarga el Excel y encuentra 12 800,00 / 4 250,00 en
«Totales» sin ninguna fila que explique la diferencia (la explicación vive solo en la ayuda de la
pantalla). Además, si suma la columna «Venta sin IGV» de «Por pedido», cuenta el doble: la fila del pedido
y cada una de sus filas de comprobante llevan la venta. Esto es heredado de «Todas», pero la entrega lo
extiende a todas las pestañas. El `db-spec` solo compara la hoja «Totales» contra la franja, así que no
lo detecta.

Arreglo sugerido: agregar a «Por pedido» una fila `Total · N pedidos` con el mismo cálculo del pie
(suma de los pedidos incluidos, no de los comprobantes), o una nota al pie de «Totales» que diga que la
franja puede diferir del pie. Cambiar el encabezado de la columna de comprobantes para que no invite a
sumar tampoco estaría de más.

### 2. P3 — Servicios: el Excel conserva la columna «Costo / Emisión» con el estado del costo; la pantalla oculta «Costo registrado» en esa pestaña

`reports-xlsx.ts:213` (la columna no está marcada `cost: true`); pantalla: `orderColumns(!noCost)`
(`ventas-margen-view.tsx:214`, la columna `status` en `:572` solo existe con costo).

Escenario: en Servicios el Excel dice «Completo»/«Costo parcial» por pedido, algo que la pantalla de
Servicios no muestra (y que no tiene sentido sin costo, D-392). No corre columnas (verificado: `pick`
mapea por el índice original y el test «Servicios» lo cubre), solo sobra una columna. Arreglo: marcarla
`cost: true` para las filas de pedido, pero conservar la fecha de emisión de las filas de comprobante
(hoy comparten columna), o separarla en dos columnas.

### 3. P3 — Inventario valorizado: la columna «Acabado» del Excel sigue siendo el código; la pantalla ahora muestra nombre (código)

`reports-xlsx.ts:131` (`c.finishCode`); pantalla: `inventario-valorizado-view.tsx:439`
(`finishText(coil.finishName, coil.finishCode, coil.ral)`).

La entrega agregó `finishName` precisamente para esto y el Excel no lo usa. Arreglo: escribir
`finishName` (o «nombre (código)») en la hoja «Bobinas».

### 4. P3 — Merma: el encabezado «Pasa la tolerancia» es ambiguo

`coil-waste-xlsx.ts:43`. El valor «Sí» significa que la merma **excede** la tolerancia (`overStandard`,
rojo en pantalla). «Pasa» se puede leer como «cumple». La hoja «Producciones» ya usa «Fuera de
tolerancia». Arreglo: renombrar la columna a «Fuera de tolerancia» (Sí/No).

### 5. P3 — Brecha de pruebas

`report-xlsx-totals.db-spec.ts`:

- Compara totales y conteos de filas, pero no el contenido de las columnas por pestaña, que es
  donde un corrimiento podría aparecer. Hoy lo cubre solo `reports-xlsx.spec.ts` con una fixture
  (Drywall y Servicios); con eso alcanza para el caso actual, pero un `it.each` sobre la hoja
  «Por pedido» comparando «Venta» de la primera fila con `screen.orders[0].salesPen` por cada
  `SALES_MARGIN_LINES` cerraría el hueco.
- Si la base de pruebas sembrada tiene pocas ventas por línea, muchas aserciones valen vacío (0 = 0).
  Conviene confirmar que la siembra deja al menos un pedido en Drywall, Coberturas UPVC y Reventa.
- No hay prueba de que `salesByMaterialXlsxFile` respete `kind`/`thicknessMm`/`color` (se afirma en el
  comentario de la ruta); el `db-spec` solo pide la consulta por línea.

---

## (B) Corte de día en Lima

Confirmado: `overdueDays` (`purchase-math.ts:184-187`) compara `dueDate.toISOString().slice(0,10)`
(correcto, `due_date` es `DATE` a medianoche UTC) contra `businessToday(now)` (Intl con
`America/Lima`); el signo es el de antes (hoy − vencimiento), y `supplierStatement`
(`purchases.service.ts:1555-1563`) toma un solo `now` para todas las filas. Los bordes 18:59 / 19:00 /
23:59 / 00:00 del test son correctos (23:59Z = 18:59 Lima, 05:00Z = 00:00 Lima). La eliminación de
`startOfDayUtc` y del `daysBetween` de `Date` no deja importaciones colgadas (grep limpio).

Búsqueda del mismo patrón (día calculado en UTC desde `new Date()` o un timestamp) en `apps/api/src`,
`apps/web/src` y `packages/shared/src`:

- Todos los `new Date()` / `Date.now()` restantes son de instantes (TTL, `createdAt`, horas de
  estancamiento del PSE, reservas temporales), no de días de negocio.
- Los `toISOString().slice(0,10)` restantes son de columnas `DATE` (`issueDate`, `dueDate`,
  `operationDate`, `validUntil`, etc.), cuya medianoche UTC es el día correcto. No encontré ninguno sobre
  un timestamp (`createdAt`, `At`) en el API ni en el web, ni SQL con `::date` sobre `*_at`.
- La entrega también corrige dos mensajes en `production.service.ts` y `roofing-production.service.ts`
  (`later.createdAt.toISOString().slice(0,10)` → `businessToday(later.createdAt)`): correcto, ese
  sí era un timestamp cortado en UTC (el mensaje decía el día siguiente entre las 19:00 y las 24:00).
- Vencimientos de CxC, tableros (admin, planta, vendedor), `receivables-aging` y vigencia de
  cotizaciones ya usan `businessToday()`.
- `imports/parse-spreadsheet.ts:101` usa getters locales a propósito (documentado en el comentario,
  día calendario de una celda de Excel); no es el patrón.

Sin hallazgos nuevos de este tipo.

---

## Lo que verifiqué y está bien

**(A) Excel contra pantalla**

- **Merma por bobina** (`coil-waste-xlsx.ts`): una fila por bobina del mismo DTO en el mismo orden,
  fila «Total · N» con `totals` del API (consumido, teórico, diferencia, despunte o merma de proceso,
  ajuste, merma, %, otra merma), la nota de «X de Y bobinas» cuando hay bobinas sin teórico, y hoja
  «Producciones» con todas las producciones (que la pantalla muestra al abrir la flecha). Las etiquetas
  cambian a «Merma de proceso» en Drywall como en la pantalla. La URL del botón lleva
  `from`, `to` y `businessLine`; la ruta valida con el mismo `coilWasteQuerySchema` que la JSON y es
  solo ADMINISTRADOR (cubierto en el spec del controlador).
- **Ventas por material**: la ruta ya no descarta `businessLine` y pasa `query` completo (filtros
  `kind`/`thicknessMm`/`color` incluidos) al mismo servicio que la pantalla; los filtros se reinician al
  cambiar de pestaña (`keep: ['from','to']`), así que no hay filtros viejos viajando en pestañas por
  producto. Coberturas UPVC y Reventa usan las columnas de `productColumns` (SKU, producto,
  cantidad, unidad en su columna, venta, costo, utilidad, costo prom./unidad) más «Líneas», y el total
  sale de `products.total` (el mismo que la pantalla muestra sin búsqueda). Las filas de cuadre de
  `reconciliationRows` replican `ReconciliationNotes` (Reventa con «bobinas enteras…», Coberturas UPVC sin
  fila de bobinas, etiquetas de «sin subtipo» y «comprados de Drywall» solo si no es cero, aviso de venta
  sin línea). El nombre del archivo de Coberturas Aluzinc no cambia.
- **Ventas y margen por línea**: `salesMarginXlsx(report, line)`; el DTO ya viene filtrado (mismo
  servicio que la JSON con `query` completo). Quitar columnas no corre nada: `keep` conserva el índice
  original y `pick` lee por él (verificado a mano en las 11 columnas para Drywall y Servicios). Servicios
  queda sin Costo/Margen/Margen % y sin «Material de OPs»; las demás pestañas sin «Material de OPs»
  (como la pantalla, que lo muestra solo en «Todas»). La hoja «Totales» de pestaña lleva el total de la
  franja (`report.totals`), y en Servicios solo la venta. Las secciones «Facturación parcial» y de costo
  no rastreable salen de los mismos `inTotals`/`costStatus` que la pantalla.
- **Inventario valorizado por línea**: la ruta valida con `inventoryValuationQuerySchema` (como la JSON)
  y el botón envía `?businessLine=`; formatos de dos decimales aplicados al índice correcto en las
  tres hojas (la celda guarda el valor completo, así que las sumas siguen dando el total).
- **SQL nuevo**: `JOIN finishes f ON f.id = c.finish_id` (columna `NOT NULL` en `Coil`) con `f."name"`
  en el `GROUP BY` de `reports.service.ts`; `cu."id"` y `u."id"` en `sales-margin.service.ts` y
  `sales-by-material.service.ts` con los alias que ya existían (el `LEFT JOIN users` deja `seller_id`
  nulo sin vendedor, coherente con el esquema `nullable`); `finishName` en `coil-waste.service.ts` por
  `include` de Prisma. No cambia el número de consultas ni la cardinalidad de filas.
- **Contrato**: solo campos agregados (`finishName`, `customerId`, `sellerId`, `dispatchNoteHasPdf`),
  ninguno quitado ni renombrado. El orden API → web de la ventana cubre el caso de la web nueva contra la
  API vieja (`dispatchNoteHasPdf` ausente = falso: oculta imprimir, no rompe).
- **Despacho**: `pdfKey` se selecciona pero no sale al DTO; solo se guarda cuando SUNAT acepta
  (`storeFiles`), así que no coincide con `noteOnTheWay` (DRAFT/ISSUED/SEND_ERROR) y no hay dos
  «Imprimir guía». El spec E2E ajustado cubre guía en camino, aceptada sin PDF y con PDF.
- **Pruebas ejecutadas**: 64 unitarios del API y 21 del web, todos verdes.
