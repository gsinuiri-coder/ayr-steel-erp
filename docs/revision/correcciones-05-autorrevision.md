# Correcciones 05 — autorrevisión

> **Esto es una AUTORREVISIÓN** (AGENTS.md §2.2.1): la hizo un subagente nuevo que no leyó el
> handoff de implementación, sobre el diff `8eeae71..HEAD` de la rama `feat/correcciones-05`
> (M1 D-354 … M5 D-358). **No vale como pase cruzado**: es una lista de riesgos, no una aprobación.
> Faltan la revisión del segundo modelo y la del dueño.

Fecha: 2026-09-27. Alcance: lectura del diff y del código que toca (inventory.service
`record`/`reverse`, roofing-production `reportInTx`/`closeInTx`/`reverseReport`/`reopen`,
dispatches.service, coil-operations `cancel`, cutting reversa, sales-margin.service), más la
corrida de los unitarios nuevos:

```
npx jest sales-by-material reports.service reports.controller coil-month-xlsx order-documents
         document-dispatches inventory-summary-meters coil-pdf
→ 9 suites, 59 tests, 59 passed
```

No corrí E2E ni nada contra bases de Neon.

## Qué verifiqué y está bien

- **Signos y reversas del kardex (M1).** `InventoryService.reverse` copia `refType`/`refId` del
  original y marca `reversalOfId` (inventory.service.ts:585-599). Por eso la reversa de un reporte
  (`PRODUCTION`, refId = reporte), la reapertura de la OP (reversa del `SCRAP`, refId = OP) y la
  anulación de un despacho (`SALE`, unida a `dispatch_items` por
  `COALESCE(reversal_of_id, id)`) se netean solas en `coilUsage` y en `factsByItem`. El `ADJUST`
  de cierre del producto va con `refId` = OP y `item_type = PRODUCT`: no entra en «producido» ni en
  el consumo de bobina. Correcto.
- **Joins que duplican.** Cada OP tiene una sola reserva y cada reserva una sola línea; `refs` no
  repite pares (ref_type, ref_id). `LEFT JOIN coils` por `reserve_item_id` es por PK. No encontré
  multiplicación de filas.
- **Enums y tipos.** `ref_type`, `item_type`, `doc_type`, `status` se comparan contra literales o
  con `::text`; `ANY(${itemIds}::uuid[])` contra columnas uuid; `c.id::text = u.coil_id::text`.
  Sin mezcla uuid/text que rompa.
- **Presupuesto de consultas.** M1: 1 + 3 en paralelo (o 1 si no hay líneas de pedido). M4:
  una consulta por página (`liveDocumentsByOrder`). M5: una por página y una en el detalle
  (`dispatchLinksByDocument`), aplicada después de paginar en `pendingOnly`. M3: una consulta
  extra por línea de negocio. Sin N+1.
- **Roles.** `sales-by-material` y su xlsx solo ADMINISTRADOR (API y nav). `coils/xlsx` con los
  mismos roles que `/reports/coils` y el mismo DTO enmascarado. `inventory/summary/coils-xlsx`
  hereda los roles de clase y usa `canSeeCosts`: VENDEDOR recibe el Excel sin columnas de costo
  (`showsCost` sale de `totalValuePen !== null`). El ML teórico es cantidad, visible a VENDEDOR
  como el resto de cantidades (D-066). Sin fuga de costos.
- **D-340 en M2.** Recorriendo los casos (vigente, terminada, anulada con saldo, anulada el mismo
  mes, ausente, saldo negativo) `cierre(M) = inicio(M+1)` se sostiene: lo que se salta siempre
  tiene inicio y cierre en cero, y lo no listado suma a los totales generales.
- **NC de M1.** Las notas de crédito son siempre por cantidad (`createCreditNoteSchema`), así que
  restar `qty` y `subtotal_pen` a la vez es coherente; la NC copia `salesOrderId` del afectado
  (invoicing.service.ts:1101), así que M4 la muestra.
- **Decimal.** Dinero y kg en `Decimal`/`toFixedString` en API, xlsx y `material-coils.ts`. Los
  `Number()` que hay son de conteo (`order_count`) u orden de opciones de espesor en la UI.

## Hallazgos

### P0

Ninguno.

### P1

**P1-1 — `metersOf` ignora la unidad del producto: una PLANCHA en KGM (o en MTR) da un ML y un
peso teórico inventados.**
`apps/api/src/reports/sales-by-material.ts:94-109` (y `sales-by-material.service.ts:148-201`, que
no trae `p."unit"`).
`metersOf` decide solo por `kind`: una PLANCHA siempre es `qty × lengthMm / 1000`. Pero AGENTS
§3.13 y `sales-lines.spec.ts:74-86` documentan que **una PLANCHA en `KGM` es legal y existe (SKU
legados)**, y el centinela cubre también PLANCHA en `MTR`.
Escenario: se factura 500 kg de una plancha legada KGM con `length_mm = 3600` →
`metersSold = 500 × 3.6 = 1 800 m` y `theoreticalKg = 1 800 × kg/m`, del orden de 3 600 kg frente a
500 kg reales: la fila muestra un «rendimiento» de +3 000 kg. Además, la base del prorrateo
(`producedQty`) está en la unidad del **kardex del producto**, que en ese SKU puede no ser la del
comprobante. En MTR el error es el mismo al revés (metros × largo).
Sugerencia: traer `p."unit"` y decidir con los predicados del dominio: `sellsByLength` → `qty`;
`sellsByFixedLength` → `qty × largo`; `KGM` → `qty ÷ kg/m` y teórico = `qty`; cualquier otro caso
(p. ej. PLANCHA NIU **sin** largo, que hoy da ML 0 en silencio) → «No trazable» con un motivo
nuevo o fuera de las filas como hoy `kind = null`, nunca un cero que se lee como dato. Un test por
cada combinación unidad × subtipo.

**P1-2 — La leyenda «Cuadre con Ventas y margen» promete una cifra que Ventas y margen no
muestra cuando hay pedidos fuera de totales.**
`apps/web/src/app/(app)/reportes/ventas-material/ventas-material-view.tsx:330-336`, frente a
`apps/api/src/reports/sales-margin.service.ts:476-509`.
`reconciliation.roofingSalesPen` es la suma de **todas** las líneas de Coberturas Aluzinc del rango.
En Ventas y margen, `totalsByLine` solo acumula los pedidos `inTotals`: los `NO_COMPARABLE` y
`NO_RASTREABLE` quedan fuera (`continue` antes de sumar a `lineTotals`). Escenario: un pedido de
coberturas con un comprobante en agosto y otro en septiembre sin despacho declarado →
`NO_COMPARABLE`; su venta de septiembre está en el «cuadre» de Ventas por material y **no** en la
fila «Coberturas» de Ventas y margen. El dueño compara y no cuadra. Lo mismo con «bobinas enteras
(allá en Comercialización)»: es solo una parte de la fila Comercialización, no una cifra que el
otro reporte muestre. El E2E cuadra **por comprobante** (`marginDocumentSales`), no contra esas
dos cifras, así que no lo detecta.
Sugerencia: o bien que Ventas y margen exponga la venta bruta por línea (incluidos los pedidos
fuera de totales) y la leyenda remita a ella, o bien reformular la leyenda como «venta del rango
de la línea, antes de exclusiones de margen», y agregar un E2E con un pedido `NO_COMPARABLE` que
fije la relación exacta. Con «cuadre exacto obligatorio» como requisito, lo decide el dueño
(regla 16).

### P2

**P2-1 — Geometría faltante da teórico 0 y un «rendimiento» negativo que parece dato.**
`sales-by-material.ts:251-256` y `figures()` 145-168. Si el producto (típicamente un ACCESORIO o
una plancha sin largo) no tiene ancho/espesor/densidad, `theoreticalKg = 0` pero `realKg` y el
costo sí suman: `yieldKg = −realKg`, que en pantalla se lee como pérdida total. Sugerencia: marcar
la fila (o esa porción) como sin teórico y mostrar «—» en rendimiento, igual que se hace con
`yieldPct` cuando el teórico es cero.

**P2-2 — Un mes cerrado cambia cuando llega facturación posterior.**
`traceFraction` usa el facturado neto **de toda la vida** de la línea (`invoicedByItem`, sin corte
de fecha). Si en octubre se factura de más una línea producida en septiembre, el reporte de
septiembre pasa de trazar 100 % a `producido ÷ facturado`. Es coherente con «sin orden de
llegada», pero conviene que el dueño lo sepa y que la pantalla lo diga: la foto de un mes no es
estable.

**P2-3 — «Sin producción aún» para una plancha de stock todavía no despachada.**
`traceFraction` (sales-by-material.ts:185-190): `DESDE_STOCK` exige `dispatched > 0`. Una plancha de
catálogo facturada antes de despacharse (sin OP propia) sale como `SIN_PRODUCCION`, que sugiere
que planta debe algo. Sugerencia: con `orderCount = 0` y producto de stock, un motivo propio
(«desde stock, pendiente de despacho») o documentar el criterio.

**P2-4 — Bobina entera sin pedido o sin `reserve_item_type = COIL` desaparece del reporte y del
cuadre.** `sales-by-material.service.ts:185-198`: el filtro de la bobina entera depende de
`blc.code`, que solo se une por la reserva de la línea de pedido. Una venta de `BOB…` sin línea de
pedido (o una NC suya sin `affected_item_id` con pedido) no entra ni como fila ni como
«No trazable SIN_PEDIDO» ni en `coilSalesPen`. Sugerencia: resolver la bobina también por el SKU
o, si no se puede, contarla en el cuadre como «bobina de reventa sin bobina resuelta».

**P2-5 — Cuadre por comprobante de varias líneas o importado no probado.**
M1 suma `fiscal_document_items.subtotal_pen`; Ventas y margen muestra por comprobante
`fiscal_documents.subtotal_pen`. Coinciden si el subtotal del documento es exactamente Σ líneas.
En importaciones «el importe del Excel manda; la diferencia se absorbe como ajuste de redondeo»
(AGENTS §7): si ese ajuste vive en el encabezado o en una línea sin producto, el cuadre por
comprobante se rompe o se corre de línea. El E2E solo prueba comprobantes de una línea.
Sugerencia: un caso con comprobante importado de varias líneas.

**P2-6 — Cobertura del SQL contra base real.** Los unitarios de M1 mockean `$queryRaw` y prueban
el armado. El E2E cubre producción + despunte, sin producción y bobina entera, pero **no** la
reversa de un reporte, la reapertura de una OP, un despacho de bobina revertido, una NC ni una
línea facturada de más. Son justamente los caminos de signo. Sugerencia: al menos un E2E con
reporte revertido + NC parcial.

**P2-7 — `coilUsage` castea `m."ref_type"::text` en el join.** `sales-by-material.service.ts:287`.
Con el cast, el índice `(ref_type, ref_id)` deja de servir para esa rama y el plan puede recorrer
`inventory_movements` entero. Hoy da igual por el volumen; sugerencia: dos ramas con literales
(`m."ref_type" = 'PRODUCTION'` / `'SCRAP'`) como en `factsByItem`.

**P2-8 — La guía de remisión muestra «—» en la columna Despacho de la lista de comprobantes.**
`apps/api/src/invoicing/document-dispatches.ts:47-49` asigna `NONE` (`[]`, `[]`) a la GRE, y
`DocumentDispatchLinks` con `invoicedDispatches = []` pinta «—» (`comprobantes-view.tsx:351-356`).
La guía **sí** tiene despacho (`dispatchId`/`dispatchCode`). Es la única fila de la tabla donde la
columna es falsa. Sugerencia: en la GRE, mostrar su `dispatchCode` o dejar los campos `undefined`
para que el componente no diga nada.

**P2-9 — La nota de crédito muestra «Del pedido: DES-…».** Mismo archivo: `payable` excluye solo
la GRE, así que una NC sin despacho declarado (siempre) recibe los despachos del pedido. Rotulado
en gris no miente (D-205), pero para un documento que resta es ruido. Sugerencia: tratar la NC
como la GRE o mostrar solo el despacho declarado de su afectado.

**P2-10 — M2: comentario incorrecto y «consumidos» ambiguo.**
`reporte-bobinas-view.tsx:147-149` dice que «inicio de las tablas + consumido por las terminadas

- saldo de las anuladas = inicio general». No es cierto cuando una terminada tuvo altas en el mes
  (`consumedKg = inicio + altas`). Además, para la madre de un partido o de un corte los kilos «consumidos»
  son kilos que pasaron a las hijas (que figuran como altas): la línea resumen los cuenta como
  consumo. Sugerencia: corregir el comentario y rotular «salidas» en vez de «consumidos».

**P2-11 — M2: `flow.exitsKg` es un despeje, no una medición.** `reports.service.ts:217-222`:
`salidas = inicio + altas − cierre`, así que el «cuadre» de la pantalla y del Excel es cierto por
construcción y no puede detectar nada; además las reversas de salidas (un despacho o reporte
revertido: `IN` con `reversal_of_id`) quedan neteadas dentro de «salidas» sin que se diga.
Sugerencia: sumar las salidas del mes desde el kardex (OUT − IN de reversas) y mostrar el cuadre
como verificación real, o rotularlo como identidad.

**P2-12 — M2: una bobina `ABSENT` con valor residual deja de sumar a `totals.closingValuePen`.**
Una bobina terminada en un mes anterior con residuo de valor por redondeo (p. ej. 0.0001) antes
sumaba a los totales y ahora se salta. Diferencia de céntimos frente al inventario valorizado.
Sugerencia: saltar por cantidad **y** valor en cero, o sumar el valor de las ausentes.

**P2-13 — E2E de fase 7 más débil.** `e2e/tests/fase7-consolidada.spec.ts:393-409`: se quitó la
aserción exacta de la madre (0 / 4 800 / 0) y quedó `finished.count >= 2`, que pasa con cualquier
bobina de otro test del mismo mes. Sugerencia: aserción sobre `finished.consumedKg` o sobre la
diferencia antes/después dentro del escenario.

**P2-14 — El Excel de Ventas por material no lleva la línea de cuadre.**
`sales-by-material-xlsx.ts:74-76` pone la venta no trazable pero no `reconciliation`. Quien
trabaje solo con el Excel no puede reconciliar. Sugerencia: dos filas más con las cifras del
cuadre.

**P2-15 — Menor.** `sales-by-material.service.ts:117-125`: `facts.find` dentro del bucle es O(n²)
sobre las líneas del rango; un `Map` por id lo resuelve. El «Estado» de las filas de M2 (pantalla
y Excel, `coil-month-xlsx.ts:47`) es el estado **de hoy**: una bobina vigente en agosto y terminada
en septiembre se lista en agosto como «Terminada». Esto ya pasaba antes de D-355; ahora que la
tabla es «solo vigentes», se nota más.

## Resumen

Sin P0. Dos P1 en M1: el ML y el teórico no miran la unidad del producto (una PLANCHA KGM/MTR
legal da cifras inventadas) y la leyenda de cuadre con Ventas y margen promete una cifra que ese
reporte no muestra cuando hay pedidos fuera de totales. El SQL de kardex (signos, reversas, joins,
enums) está bien, M2 sostiene `cierre(M) = inicio(M+1)`, y M3–M5 no tienen N+1 ni fugas de costos.
Los P2 son casos borde de clasificación, huecos de prueba contra base real y detalles de UI (GRE y
NC en la columna Despacho).

## Respuesta de la sesión (commit `0ccdb52`)

- **P1-1 (unidad del producto): corregido.** El ML sale de la unidad de venta (`MTR` → cantidad; `NIU`
  con largo → cantidad × largo; bobina entera → ML de sus kilos). Lo que no tiene conversión va a
  «No trazable» con el motivo nuevo `SIN_METRO` («Unidad sin conversión a metros lineales»), nunca como
  cero. Test con una plancha en kilos y una en piezas sin largo.
- **P1-2 (leyenda del cuadre): corregido en la leyenda, con la decisión de fondo para el dueño.** La
  leyenda dice qué es la cifra (venta de Coberturas Aluzinc facturada en el rango, todos los
  comprobantes) y dónde está en «Ventas y margen» (la fila de la línea más los pedidos que deja fuera de
  sus totales; las bobinas enteras dentro de Comercialización). El Excel lleva las dos cifras. El cuadre
  exacto se prueba por comprobante (E2E) y se verifica en producción con las dos cifras a la vista.
- **P2 tomados:** el cast del enum en la unión con el kardex (índice), la guía de remisión con su propio
  despacho, el residuo de valor de una bobina que no figura, el comentario y la aserción del cuadre de M2,
  y la línea de cuadre en el Excel.
- **P2 anotados sin cambio:** geometría faltante (teórico 0 y rendimiento negativo; no hay productos de
  la línea sin geometría — el catálogo la exige), un mes cerrado que cambia si después se factura de más
  (se lee el facturado de toda la vida, criterio del prorrateo aprobado), plancha de stock facturada y no
  despachada como «sin producción aún», venta de bobina sin línea de pedido fuera del cuadre, casos de E2E
  sin cubrir (reversas, NC, facturación de más; cubiertos por unitarios), NC con «Del pedido», las salidas
  de M2 despejadas en vez de medidas (el cuadre cierra por construcción; lo que se verifica es que las
  líneas de abajo las explican), y el E2E de fase 7 con `finished.count >= 2` (la base de E2E es
  compartida).
