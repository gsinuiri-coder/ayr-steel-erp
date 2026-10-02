# Autorrevisión — cc13 (D-378, reactivar con las líneas del pedido)

> **Esto es una autorrevisión, no un pase cruzado.** La hizo un subagente nuevo de Claude Code
> que no leyó el handoff de implementación (`docs/handoff/`) ni `docs/PROGRESO.md`. Es una
> **lista de riesgos, no una aprobación**: no vale como revisión independiente (AGENTS.md §2.2).

## Alcance

- Diff revisado: `git diff origin/main...HEAD` en `cc13/reactivar-con-lineas`, tres commits
  (`f82eb77` API, `334514f` web y `4ca71ec` E2E). Las líneas citadas son las de **HEAD**.
- Durante la revisión, el árbol de trabajo tenía cambios sin commitear de otra sesión
  (`fiscal-import.service.ts`, el spec, el diálogo, docs). **No se revisaron como entrega.**
  Solo se miraron para no reportar como abierto algo que ya se estaba arreglando, y cuando
  pasa se marca «en curso en el árbol de trabajo».
- Contexto leído: `AGENTS.md`, las filas D-377 y D-378 de `docs/ARQUITECTURA.md` §0.2,
  `invoicing.service.ts` (`create`/`createInTx`/`resolveLines`, `registerManual`,
  `assignInTx`, `createCreditNote`, `assertStillAvailable`),
  `sales-order-edits.service.ts#lockEditable` y `updateItemCoilInTx`, `invoicing-net.ts`,
  `invoice-dispatch.service.ts` (`executeInTx`, `buildPlan`), `reports/sales-by-material` y
  `sales-margin` (consultas sobre `fiscal_document_items`), los CHECK de `fiscal_documents` y
  `fiscal_document_items` en `apps/api/prisma/migrations`, el modelo Prisma y
  `@ayr/shared` (`sumLineTotals`, `roundDocumentTotals`, `derivedUnitValue`, `toFixedString`).
- Corrido:
  - `pnpm --filter @ayr/api exec jest src/invoicing`: **20 suites, 286 tests, todo verde**
    (contra el árbol de trabajo).
  - `pnpm --filter @ayr/api exec tsc --noEmit -p tsconfig.json`: **rojo**. La primera
    corrida dio `TS2322` en `fiscal-import-reactivate-lines.spec.ts:282`, que está en HEAD
    (hallazgo 5). La segunda dio `TS2304` por `REACTIVATION_TX_TIMEOUT_MS`, que viene del
    árbol de trabajo a medio editar y no es de HEAD.
  - No se corrió Playwright ni se levantó ningún servidor.

## Veredicto

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 0        |
| P2        | 5        |
| P3        | 5        |

No encontré daño de datos ni bloqueos rotos. Los CHECK se respetan: `qty > 0` (el schema de
pedido exige cantidad positiva), importes `>= 0`, `annul_shape`/`annulled_trace` con
`annulled_at`/`annulled_by_id`/`annul_reason` en null y el único `(document_id, line_number)`
(los números nuevos siguen al máximo). El orden de locks comprobante → pedido → borradores no
choca con `createInTx` (pedido y después inserta), `registerManual`/`assignInTx` (solo su
fila), `createCreditNote` (solo el afectado), `lockEditable` (pedido, lectura sin lock de
comprobantes) ni `invoice-dispatch#executeInTx` (pedido y lectura). **D-373 no cambia de
comportamiento**: `lockAnnulledForReactivation` es el mismo bloque extraído, con un `select`
más ancho; el lock de borradores y `assertLinesNotReinvoiced` de D-373 quedan iguales, y
`fiscal-import-reactivate.spec.ts` pasa. Todo es `Decimal`/string; no hay `number` en dinero.

## Hallazgos

### 1. P2: la fila actualizada en su lugar conserva el `productId` (y la unidad) viejos aunque la línea del pedido haya cambiado de producto

- **Dónde:** `apps/api/src/invoicing/fiscal-import.service.ts:367-377` (el `update` solo toca
  `qty`, `unitPricePen` e importes) y `apps/api/src/invoicing/reactivate-order-lines.ts:144`.
- **Escenario:** mientras el comprobante está anulado, `lockEditable` deja editar el pedido. Con
  «cambiar la bobina» (`sales-order-edits.service.ts#updateItemCoilInTx`, auditada como
  `sales.order.item-coil`), la línea pasa a otro `productId` (el producto de venta de esa
  bobina) y la unidad a `KGM`. D-378 admite esa edición, pero reescribe la fila del
  comprobante con la cantidad y el importe nuevos y le deja el `product_id` anterior.
  `reports/sales-by-material.service.ts:244-269` y `sales-margin.service.ts:271` agrupan los
  ingresos por `fdi.product_id`, así que esa venta queda atribuida al material viejo. Si la
  unidad también cambió, la fila puede mostrar kilos con una unidad que no es `KGM`.
- **Sugerencia:** si `o.productId !== d.productId`, bloquear con un mensaje que nombre la
  línea, o actualizar `productId` (lo interno) y conservar solo descripción y unidad del papel.
  Lo que se elija, que quede en la auditoría (hoy `before.lines` no lleva el producto).
  Agregar un caso al spec.

### 2. P2: el «Antes» y la auditoría muestran una cabecera recalculada, no la que estaba grabada

- **Dónde:** `reactivate-order-lines.ts:98` (`side()` = `sumLineTotals` de las filas) y
  `reactivate-order-lines.ts:181`, más `fiscal-import.service.ts:399-402`. El lock común lee
  `subtotalPen`/`igvPen`/`totalPen` del comprobante (`:751`) pero nunca los usa.
- **Escenario:** D-377 es «solo hacia adelante»: un manual grabado antes de R2 puede tener una
  cabecera distinta, por 1 o 2 céntimos, de `céntimo(Σ líneas)`. Por ejemplo, si se registró
  con céntimo por línea o con el total del papel. El modal muestra en «Antes» un total que no
  es el que tenía el comprobante. Además, el `before` de la auditoría guarda ese total
  recalculado: el valor real que la fila deja de guardar se pierde, aunque el propio
  comentario dice que la auditoría es la copia de «la cabecera de antes» (RF-95).
- **Sugerencia:** en el `before` de la auditoría y en el DTO, usar los importes grabados de la
  cabecera (`document.subtotalPen/igvPen/totalPen`). Si se quiere, mostrar también la suma
  recalculada cuando difiera.

### 3. P2: la transacción usa el timeout por defecto de Prisma (5 s) y hace un `update` por línea

- **Dónde:** `fiscal-import.service.ts:304` (vista previa) y `:339` (reactivación);
  `:367-377` es el bucle de `update`.
- **Escenario:** son unas 13 consultas fijas (locks, auditoría, cobros, notas de crédito,
  pedido, líneas, borradores, otros, cliente, cabecera, `createMany`, auditoría) más una por
  línea del comprobante. Contra Neon, en un pedido grande, se acerca a los 5 s, y el
  `create` del mismo módulo ya usa `timeout: 30_000`. Si vence, el usuario ve un error sin
  causa clara y hay que reintentar (no hay escritura parcial, porque es una transacción).
- **Estado:** en curso en el árbol de trabajo (`REACTIVATION_TX_TIMEOUT_MS = 30_000`). Hay que
  verificar que entre en el commit.

### 4. P2: `plan.changed` se calcula y no se usa, así que se puede «reactivar con las líneas del pedido» sin cambiar nada

- **Dónde:** `reactivate-order-lines.ts:183` y `fiscal-import.service.ts:549`.
- **Escenario:** si el pedido describe exactamente lo que el comprobante ya tenía, HEAD
  reactiva igual: reescribe las filas con los mismos valores y audita
  `reactivate-with-order-lines`. Pero salta los bloqueos propios de D-373
  (`assertOrderLinesUnchanged` y la cuenta por línea de `assertLinesNotReinvoiced`) y los
  reemplaza por los de D-378, que son más estrictos en «otros comprobantes». No hay daño de
  datos, pero la fila D-378 de §0.2 en el árbol de trabajo ya dice que esto **bloquea**, y HEAD
  no lo hace.
- **Estado:** en curso en el árbol de trabajo (`if (!plan.changed) throw …`). Verificar que se
  commitee junto con su test.

### 5. P2: typecheck rojo en HEAD

- **Dónde:** `apps/api/src/invoicing/fiscal-import-reactivate-lines.spec.ts:282`:
  `documentBalance({ …, paidPen: 0, creditedPen: 0 })` pasa `number` donde va `DecimalInput`
  (`TS2322`). Jest pasa porque no hace typecheck; `tsc --noEmit` y la CI fallan.
- **Sugerencia:** `'0'` en vez de `0`. Ya figura en el árbol de trabajo. Después del arreglo,
  correr de nuevo `tsc` sobre el commit final, no sobre el árbol a medias.

### 6. P3: la vista previa es un `GET` que toma `FOR UPDATE` sobre el comprobante, el pedido y los borradores

- **Dónde:** `fiscal-import.service.ts:304` → `planReactivationWithOrderLines` (`:474` y `:506`).
- **Escenario:** abrir el modal serializa por un momento las ediciones del pedido, la creación
  de borradores y los cobros sobre ese comprobante. La transacción es corta y no hay deadlock,
  porque el orden es el mismo. Es un efecto lateral en un `GET`, y la reactivación vuelve a
  comprobar todo de todos modos. Según el árbol de trabajo se decidió mantenerlo; solo queda
  anotado.

### 7. P3 (web): la coma decimal se convierte en otro número

- **Dónde:** `apps/web/src/components/invoicing/reactivate-with-order-lines-dialog.tsx:56-60`
  (`typedTotal` borra todas las comas).
- **Escenario:** si el usuario tipea `153,44`, se interpreta como `15344.00` y el modal dice
  «No coincide: papel S/ 15,344.00 … diferencia …». No se reactiva nada mal, porque el botón
  queda deshabilitado, pero el mensaje confunde.
- **Sugerencia:** rechazar el valor con el mensaje «hasta dos decimales, por ejemplo 153.44»
  cuando la coma va seguida de 1 o 2 dígitos al final, o aceptar la coma como separador
  decimal.

### 8. P3 (web): después de un rechazo del servidor la vista previa queda vieja; los `role="alert"` se anuncian en cada tecla

- **Dónde:** `reactivate-with-order-lines-dialog.tsx:191-193` (`onError` solo muestra un toast)
  y `:259-267`.
- **Escenario:** si entre la vista previa y el envío alguien cambió el pedido, el servidor
  rechaza con los dos totales, pero «Después» sigue mostrando las líneas viejas. Por otro
  lado, el aviso «No coincide» tiene `role="alert"` y se vuelve a anunciar con cada tecla
  mientras se tipea el total. El «Calculando…» tampoco tiene `aria-live`.
- **Sugerencia:** en `onError`, `preview.refetch()`. Para el aviso, `aria-live="polite"` en vez
  de `role="alert"`, o mostrarlo al salir del campo.

### 9. P3: huecos de test

- No hay caso de unidad para:
  - una línea del pedido cuyo producto cambió (hallazgo 1);
  - una cabecera grabada distinta de `céntimo(Σ líneas)` (hallazgo 2);
  - una línea ya despachada a la que se le cambió el precio: debe actualizar importes y
    conservar el despacho.
- Los specs de `fiscal-import-reactivate-lines.spec.ts` son con mocks, así que los CHECK
  reales (`qty_ck`, `annul_shape_ck`, el único `(document_id, line_number)`) solo los prueba el
  E2E. No se corrió en esta revisión.

### 10. P3: la auditoría no identifica las filas

- **Dónde:** `fiscal-import.service.ts:399` y `:410`. `before.lines` y `after.lines` llevan
  número de línea y número de línea del pedido, pero no el `id` de cada
  `fiscal_document_item` ni el `productId`. Si después hay que reconstruir qué fila cambió y a
  qué producto apuntaba (por ejemplo, para un reporte o para el hallazgo 1), falta ese dato.
- **Sugerencia:** agregar `id` (en las actualizadas) y `productId` a cada línea del `before` y
  del `after`. Las creadas se identifican por `lineNumber`.

## Resolución (autor, 2026-10-02)

| #   | Qué se hizo                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Corregido.** Si la línea del pedido cambió de producto, la fila toma `productId`, descripción y unidad del pedido; si no, conserva descripción y unidad del papel. Test de unidad nuevo.                                                                                |
| 2   | **Corregido.** El «antes» (modal y auditoría) muestra la cabecera grabada (`planOrderLines(…, storedHeader)`); el «después» sigue con D-377. Test de unidad nuevo.                                                                                                        |
| 3   | **Corregido.** `timeout` de 30 s en la vista previa y en la reactivación (`REACTIVATION_TX_TIMEOUT_MS`), el mismo margen que `create`.                                                                                                                                    |
| 4   | **Corregido.** Si el pedido describe lo mismo que el comprobante, se rechaza: «… no hay nada que cambiar. Usa «Reactivar»». Test de unidad nuevo.                                                                                                                         |
| 5   | **Corregido.** `paidPen`/`creditedPen` como string; `tsc --noEmit` limpio.                                                                                                                                                                                                |
| 6   | **Aceptado, documentado en el código.** Mismo camino y mismos locks que la reactivación: la transacción es corta y no escribe, y así la vista previa no puede dejar de mostrar un bloqueo que la reactivación sí aplicaría.                                               |
| 7   | **Corregido.** La coma solo vale como separador de miles bien puesto (`1,234.50`); `153,44` pide el formato.                                                                                                                                                              |
| 8   | **Corregido.** Tras un rechazo del API la vista previa se vuelve a pedir; el aviso de diferencia es `aria-live="polite"` en vez de `role="alert"`.                                                                                                                        |
| 9   | **Corregido en parte.** Tests de cambio de producto, cabecera grabada y línea facturada en parte. El cambio de precio de una línea despachada lo cubre el plan (importes del pedido) y la conservación del despacho, el E2E (id del comprobante y de la fila sin cambio). |
| 10  | **Corregido.** La auditoría lleva `rows` con `id`, número de línea y `productId` del antes, y `id`/`productId` de las actualizadas y número de línea/`productId` de las creadas en el después.                                                                            |
