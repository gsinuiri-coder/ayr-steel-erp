# Revisión de segundo modelo — Correcciones 05

> **Este informe lo escribió un segundo modelo (Sonnet 5, contexto limpio), no una persona.**
> Es un pase de revisión sobre `git diff 8eeae71..HEAD` (rama `feat/correcciones-05`), no una
> aprobación. P0/P1 se corrigen antes del deploy; la revisión del dueño sigue siendo la única
> que cierra la revisión (§0.1 de `AGENTS.md`).

## Alcance revisado

- M1/D-354 — `apps/api/src/reports/sales-by-material.service.ts`, `sales-by-material.ts`,
  `sales-by-material-xlsx.ts` y sus specs; `apps/web/.../reportes/ventas-material/*`;
  `apps/web/src/lib/material-coils.ts`.
- M2/D-355 — `apps/api/src/reports/reports.service.ts`, `coil-month-xlsx.ts`,
  `apps/api/src/coils/coil-pdf.ts`; `apps/web/.../reportes/bobinas/reporte-bobinas-view.tsx`.
- M3/D-356 — `apps/api/src/coils/coils.service.ts`, `apps/api/src/inventory/inventory.service.ts`,
  `inventory.controller.ts`, `inventory-summary-xlsx.ts`; `apps/web/.../bobinas-view.tsx`,
  `inventario-view.tsx`.
- M4/D-357 — `apps/api/src/sales/order-documents.ts`, `sales-orders.service.ts`;
  `apps/web/.../pedidos/*`, `apps/web/src/components/sales/order-documents.tsx`.
- M5/D-358 — `apps/api/src/invoicing/document-dispatches.ts`, `invoicing.service.ts`;
  `apps/web/.../comprobantes/*`, `apps/web/src/components/invoicing/document-dispatches.tsx`.
- Compartido: `apps/web/src/components/overflow-list.tsx` (nuevo, reusado por
  `production/order-history.tsx`), specs de e2e tocados (`bobinas-metro-lineal-d281`,
  `correcciones-03-listas-kardex`, `fase7-consolidada`, `film-bobina-d328`,
  `ventas-material-d354`), esquemas de `packages/shared/src/schemas/*`.

## Cómo se verificó

- Lectura completa del SQL crudo de las cuatro consultas de `SalesByMaterialService` y de la
  consulta agregada de `ReportsService.coilsByMonth`, contrastadas contra el dominio real:
  `InventoryService.reverse` (para el signo IN↔OUT de una reversa y por qué la reversa de un
  ADJUST se queda en ADJUST), `CoilOperationsService.cancel`/`revertSplit`,
  `cutting.service.ts` (recepción de corte) y `purchases.service.ts` (anulación de compra), para
  confirmar que **toda** anulación que deja una bobina en `CANCELLED` pasa por revertir su
  entrada (por eso `annulled_on` la puede encontrar como `type='OUT' AND reversal_of_id IS NOT
NULL`).
- Lectura de `dispatches.service.ts` para confirmar que `dispatchItem.movementId` **no** se
  reescribe al revertir un despacho (sigue apuntando al movimiento original), que es la premisa
  detrás del `COALESCE(m."reversal_of_id", m."id")` de `coilUsage`.
- Contraste de `sales-margin.service.ts` (`LIVE_STATUSES` local) contra `LIVE_DOCUMENT_STATUSES`
  (`@ayr/shared`) para confirmar que hoy son la misma lista de cuatro estados, condición para
  que el cuadre M1 sea exacto.
- Conteo manual de columnas de cabecera contra cada `colSpan` tocado (`comprobantes-view.tsx`,
  `pedidos-view.tsx`, `inventario-view.tsx`).
- Corrida bloqueante de los unitarios del alcance:
  `cd apps/api && npx jest src/reports/reports.service.spec.ts
src/reports/sales-by-material.service.spec.ts src/reports/reports.controller.spec.ts
src/reports/coil-month-xlsx.spec.ts src/reports/sales-by-material-xlsx.spec.ts
src/inventory/inventory-summary-meters.spec.ts src/sales/order-documents.spec.ts
src/invoicing/document-dispatches.spec.ts src/coils/coil-pdf.spec.ts` → **9 suites, 60
  tests, todos verdes**.
- No se corrió E2E (requiere servidor local vivo; fuera del alcance de este pase) ni se tocó
  `.env*`, git, ni ningún comando contra `production`.

## P0 — ninguno encontrado

No encontré nada que corrompa datos, viole el kardex append-only, ni filtre costos a un rol que
no debe verlos. Los cuatro reportes nuevos (`sales-by-material`, `coils/xlsx`, `coils/pdf`,
`summary/coils-xlsx`) heredan el mismo enmascarado por rol (`canSeeCosts`) que sus pantallas
hermanas, y `sales-by-material` (que sí lleva costo/kg) está cerrado a `Role.ADMINISTRADOR` en
JSON y en xlsx.

## P1 — corregir antes del deploy

### P1-1. El presupuesto de consultas «cuatro, fijas» de D-354 no lo prueba ningún test

**Archivo:** `apps/api/src/reports/sales-by-material.service.spec.ts` (todo el archivo);
compárese con `apps/api/src/reports/sales-margin.service.spec.ts:410-430` y
`apps/api/src/sales/order-documents.spec.ts:120`, `apps/api/src/invoicing/document-dispatches.spec.ts:160`.

El docstring de `SalesByMaterialService.report` (`sales-by-material.service.ts:94-95`) afirma:

> Presupuesto de consultas: **cuatro, fijas**, sin importar cuántas líneas entren en el rango.

Es exactamente el mismo tipo de invariante que **sí** se prueba en los tres archivos hermanos de
esta misma entrega y de la vecina (`sales-margin.service.spec.ts` tiene el test literal
`'presupuesto de consultas: seis, y el conteo no cambia con diez pedidos y veinte
comprobantes'`, que hace crecer el fixture y compara `calls.length`). El spec de M1 sí trackea
`calls` (línea 69) y sí tiene el caso `'sin líneas de pedido en el rango no gasta más consultas'`
(la rama de 1 consulta), pero **no tiene el caso simétrico con líneas** que compruebe que el
camino con `itemIds.length > 0` se queda en 4 consultas y no crece si, por ejemplo, alguien
cambia `Promise.all([...])` por consultas por-línea en un cambio futuro. AGENTS.md §6 pide
exactamente esto («un presupuesto de consultas verificado por test, nunca caché silenciosa»), y
es la clase de regresión (N+1) que no se ve en un diff ni en un review manual, solo en un test
que hace crecer el fixture.

**Sugerencia:** agregar un test como el de `sales-margin.service.spec.ts:410`: sembrar 2–3
líneas de pedido con `usage`/`facts`/`invoiced` no triviales y afirmar `calls.length === 4` (o
`toHaveLength(4)`), y opcionalmente repetir con el doble de líneas para mostrar que no crece.

## P2 — mejoras

### P2-1. `CoilsDialog` (Ventas por material): `colSpan` del estado vacío no coincide con las columnas en vista «Sumado»

**Archivo:** `apps/web/src/app/(app)/reportes/ventas-material/ventas-material-view.tsx:508-525`.

La tabla del modal tiene 5 columnas en vista «Sumado» (`Bobina`, `Espesor`, `Color`, `Kg
consumidos`, `Costo`; la columna `Tipo` solo aparece `{view === 'split' && ...}`, línea 514),
pero la fila de `Sin bobinas.` usa `colSpan={6}` fijo (línea 522), sin condicionar al `view`
actual. En la práctica es difícil de disparar (una fila visible normalmente trae al menos una
bobina trazada), pero si algún día aparece (p. ej. una fila cuyo `baseQty` viene de
`producedQty` pero cuya `coilUsage` vino vacía por un hueco de datos), la celda de «Sin
bobinas.» queda con un `colSpan` de más en la vista por defecto.

**Sugerencia:** `colSpan={view === 'split' ? 6 : 5}`.

### P2-2. Duplicación de `LIVE_STATUSES`/`LIVE_DOCUMENT_STATUSES` entre `sales-margin.service.ts` y `sales-by-material.service.ts`

**Archivos:** `apps/api/src/reports/sales-margin.service.ts:26` (constante local `LIVE_STATUSES`,
no tocada por este diff) vs. `apps/api/src/reports/sales-by-material.service.ts:21` (usa
`LIVE_DOCUMENT_STATUSES` de `@ayr/shared`, que este diff sí adopta).

Hoy las dos listas son idénticas (`ISSUED`, `SEND_ERROR`, `ACCEPTED`, `VOID_PENDING`), así que el
«cuadre exacto» que M1 promete con «Ventas y margen» se sostiene. Pero como `sales-margin.service.ts`
no fue tocado por esta entrega y sigue con su propia constante local en vez de la compartida, un
estado nuevo que alguna vez se agregue a un solo lado (p. ej. a `LIVE_DOCUMENT_STATUSES` para otro
reporte, sin acordarse de `sales-margin.service.ts`) rompería el cuadre en silencio: ningún test
cruza ambos archivos para detectarlo, y `sales-by-material.spec.ts` no puede verlo porque simula
sus propias filas.

**Sugerencia (fuera del alcance de esta entrega, para anotar como deuda):** cuando se vuelva a
tocar `sales-margin.service.ts`, reemplazar su `LIVE_STATUSES` local por
`LIVE_DOCUMENT_STATUSES` de `@ayr/shared`, la misma que ya usa D-354 y D-357. No lo marco como
P1 porque no es un defecto de esta entrega: es un riesgo latente que esta entrega hereda y no
empeora.

### P2-3. `traceFraction`/`coilUsage`: sin cobertura explícita para «BOB…» cuya reserva no resolvió a una bobina real

**Archivo:** `apps/api/src/reports/sales-by-material.service.ts:184-189` (`LEFT JOIN "coils" c
ON soi."reserve_item_type"::text = 'COIL' ...`).

El filtro de bobina entera exige `blp."code" = 'trading' AND SKU LIKE 'BOB%' AND
blc."code" = 'metallic-roofing'`, y esa última condición depende del `LEFT JOIN` a `coils`
resolviendo. Confirmé por código que hoy `reserve_item_id`/`reserve_item_type` en
`sales_order_items` es un campo congelado al armar el pedido (no una reserva viva que se pueda
vaciar), así que en el flujo normal siempre hay una bobina del lado `c`. No encontré un
camino de datos real donde una línea `trading`+`BOB%` tenga `reserve_item_type <> 'COIL'`, pero
tampoco hay un test que documente qué pasa si ocurriera (la línea simplemente desaparecería del
reporte sin pasar por «No trazable», porque el filtro del `WHERE` la excluye antes de llegar a
`assembleSalesByMaterial`). Si el dueño ve algún día una `BOB…` en «Ventas y margen» → trading
que no aparece ni en las filas ni en «No trazable» de M1, este es el primer lugar a mirar.

**Sugerencia:** no es una corrección necesaria hoy; dejarlo anotado como el primer sitio a
revisar si aparece esa discrepancia (mismo espíritu que la lista de riesgo de kardex/datos de
`docs/PROGRESO.md`).

## Lo que verifiqué y **no** encontré roto

- Signos de kardex: `coilUsage` y `factsByItem` usan `IN→resta / OUT→suma` de forma consistente
  con `InventoryService.reverse`, incluida la asimetría real (reversa de IN → OUT, de OUT → IN,
  de ADJUST → ADJUST) — no hay ningún `CASE` que asuma que una reversa siempre es del tipo
  contrario.
- `traceFraction`: el prorrateo (`facturado ÷ producido` o `facturado ÷ despachado` en bobina
  entera) reparte la misma fracción a todas las líneas del **mismo** ítem de pedido sin importar
  el orden de llegada de los comprobantes, tal como dice su propio comentario, y la suma de
  `realKg` atribuido nunca supera el consumo real (`baseQty`).
- El cuadre D-354 (`reconciliation.roofingSalesPen`/`coilSalesPen`) reproduce exactamente el
  criterio de D-247 (`sales-margin.service.ts.salesByLine` agrupa por `business_line_id` del
  **producto**, así que una bobina entera cae en «trading», no en «metallic-roofing» — es lo que
  la leyenda de la pantalla explica).
- D-355: `monthPresence` cierra los cinco casos (`LISTED`, `FINISHED`, `ANNULLED_WITH_OPENING`,
  `ANNULLED_SAME_MONTH`, `ABSENT`) sin solapamiento, y el cuadre `inicio + altas − salidas =
cierre` se sostiene tanto en el test unitario (`reports.service.spec.ts`) como en el E2E nuevo
  contra Postgres real (`film-bobina-d328.spec.ts`, caso de anulación en el mismo mes).
- `colSpan` de las tablas tocadas en `comprobantes-view.tsx` (8→9), `pedidos-view.tsx` (7→8) e
  `inventario-view.tsx` (`columnCount` dinámico) coinciden con las columnas reales añadidas.
- Ningún `number`/`parseFloat` nuevo opera dinero o kilos; el único `Number(...)` nuevo fuera de
  specs es sobre un conteo (`order_count`) y sobre un espesor en mm solo para ordenar opciones de
  un `<select>`, no para persistir ni calcular montos.
- Roles: `sales-by-material` (JSON y xlsx) exige `ADMINISTRADOR`; `summary/coils-xlsx` hereda el
  `@Roles` de clase de `InventoryController` (mismo trío que `/inventory/summary`) y enmascara
  costo con el mismo `canSeeCosts` que la pantalla — no hay xlsx que muestre un costo que su JSON
  hermano no muestre.
- `OverflowLinks`/`OverflowPopover` (nuevo, compartido) llevan `aria-label` en el botón «+N» y
  foco visible (`focus-visible:outline`); el refactor de `production/order-history.tsx` conserva
  el mismo `data-testid` (`used-coils-more`) y el mismo texto accesible que antes, así que no
  debería romper los E2E existentes de esa pantalla.

## Resumen de tests corridos

```
PASS src/coils/coil-pdf.spec.ts
PASS src/reports/reports.service.spec.ts
PASS src/reports/sales-by-material-xlsx.spec.ts
PASS src/invoicing/document-dispatches.spec.ts
PASS src/inventory/inventory-summary-meters.spec.ts
PASS src/reports/coil-month-xlsx.spec.ts
PASS src/reports/sales-by-material.service.spec.ts
PASS src/sales/order-documents.spec.ts
PASS src/reports/reports.controller.spec.ts

Test Suites: 9 passed, 9 total
Tests:       60 passed, 60 total
```

## Respuesta de la sesión

- **P1 (presupuesto de consultas de M1): corregido.** Test que corre el reporte con 1 y con 60 líneas de
  pedido y afirma cuatro consultas en los dos casos.
- **P2-1 (`colSpan` del modal): corregido** (5 en «Sumado», 6 en «Desglosado»).
- **P2-2 (`LIVE_STATUSES` local de «Ventas y margen»): anotado como deuda.** No se tocó ese servicio en
  esta entrega; el reporte nuevo usa `LIVE_DOCUMENT_STATUSES` y hoy son idénticas.
- **P2-3 (bobina entera por `reserve_item_id`): anotado** como primer lugar a mirar si aparece una
  diferencia en el cuadre de bobinas.
