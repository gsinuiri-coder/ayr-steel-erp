# cc58-a — AUTORREVISIÓN (lista de riesgos, no es una aprobación)

> **Autorrevisión** según AGENTS.md §2.2.1: subagente nuevo, sin haber leído el handoff de
> implementación. No vale como pase cruzado ni cierra la revisión: es una lista de riesgos para el
> segundo modelo y para el dueño.

- Alcance: `git diff origin/main..cc58-a` (commit `dd03cac7`), 21 archivos.
- Solo lectura: no se corrió ningún db-spec ni se modificó código.
- Nota: al revisar, el árbol de trabajo tenía cambios sin commitear en
  `apps/api/src/invoicing/invoicing.service.ts` (guarda en `retry`/`correct` y en `send`, «revisión
  del segundo modelo P2-1»). Esta autorrevisión juzga el commit; donde el cambio en curso toca un
  hallazgo, se dice.

## Resumen

| Sev | Hallazgo                                                                                         |
| --- | ------------------------------------------------------------------------------------------------ |
| P1  | La guarda de rol D-678 se salta registrando un **borrador** de NC 01/06/07 con `register-manual` |
| P2  | En «Ventas y margen» la fila deja de cumplir Venta − Costo = Margen (pantalla y Excel)           |
| P2  | La guarda bloquea también el 01 electrónico, que no reingresa nada por ese camino (verificar)    |
| P3  | Fila de Servicios: margen S/ 0,00 y, con el redondeo D-461, un % espurio                         |
| P3  | El 01 sin despacho (no mueve stock) ya no lo puede registrar el vendedor                         |
| P3  | `preview` de NC de devolución sigue abierto al vendedor                                          |
| P3  | Alerta de «devuelto por completo»: enlace a `/devoluciones/:id` para SUPERVISOR_PLANTA           |
| P3  | Índice `(document_id, reversed_at)` deja redundante `@@index([documentId])`                      |
| P3  | `priceWithIgvPen` obligatorio: pestaña abierta antes del deploy recibe 400                       |
| P3  | Rentabilidad del comprobante vs. margen por comprobante de «Ventas y margen»                     |

---

## P1 — `registerManual` de un borrador de NC que devuelve stock no pasa por `assertStockCreditNoteRole`

- `apps/api/src/invoicing/invoicing.service.ts:1719-1734` (`registerManual`) y
  `:1742` en adelante (`registerManualInTx`, que en `:1809`/`:1860` crea la devolución con
  `salesReturns.createForCreditNoteInTx` → reingreso al kardex).
- La guarda se puso solo en `createCreditNote` (`:1101`) y `registerCreditNote` (`:1130`).
  `registerManual` solo hace `assertOwnership` (el vendedor dueño del pedido pasa) y, dentro,
  `assertIssueDate` (solo la fecha).
- Escenarios:
  1. Un **borrador** de NC 06/07/01 sobre un comprobante manual creado por un vendedor **antes del
     deploy** (createCreditNote en modo `DRAFT` sí admite afectado manual: `planForLines` en `:1455`
     corre justamente para ese caso). Tras el deploy, el mismo vendedor lo registra con
     `POST /invoicing/documents/:id/register-manual` → reingreso de mercadería por un vendedor.
  2. Un administrador deja el borrador sobre un pedido del vendedor; el vendedor lo registra.
- El cambio en curso (sin commitear) agrega la guarda a `send` y a `correct`, **no** a
  `registerManual`: el hueco sigue.
- Sugerencia: llamar `assertStockCreditNoteRole(actor, document.creditNoteReason)` en
  `registerManualInTx` (cubre los dos llamadores; para el de un paso es redundante pero inocuo), o en
  `registerManual` antes de la transacción, y sumar el caso al spec de la guarda. Antes del deploy,
  convendría saber si hay borradores vivos de NC 01/06/07 en producción (lectura por la CLI, no SQL).

## P2 — La fila de «Ventas y margen» ya no cuadra Venta − Costo = Margen

- `apps/api/src/reports/sales-margin.service.ts:652-653`, `:683-684`, `:703-704`;
  `apps/api/src/reports/reports-xlsx.ts:255-266` (hoja «Por pedido») y `:343-360` (hoja
  «Comprobantes»); `apps/web/src/app/(app)/reportes/ventas-margen/ventas-margen-view.tsx` (columnas de
  la tabla y detalle por comprobante, `:700-740`).
- Escenario: pedido en «Todas» con S/ 1 000 de Coberturas (costo 700) y S/ 100 de Servicios. Antes:
  Venta 1 100, Costo 700, Margen 400 (36,36 %). Ahora: Venta 1 100, Costo 700, **Margen 300**
  (30 %). Quien lee la fila o resta columnas en el Excel ve 1 100 − 700 ≠ 300 y no hay columna que lo
  explique: `noCostSalesPen` viaja en el DTO pero no se muestra por fila ni se exporta.
- Lo mismo por comprobante: `docBase` resta Servicios y «Sin línea», pero la columna Venta del
  comprobante sigue con el subtotal entero.
- El porcentaje del pie y la franja sí coinciden ahora (era el objetivo de E-04). El riesgo es de
  lectura/conciliación, no de cálculo. Opciones para el dueño: mostrar «Venta con costo» (o «sin
  costo registrado») por fila y en el Excel, o dejar el margen en soles como antes y cambiar solo la
  base del %. Necesita decisión (regla 16), no cambio silencioso.

## P2 — La guarda alcanza también al 01 electrónico, que por `createCreditNote` no reingresa nada

- `apps/api/src/invoicing/invoicing.service.ts:269-275` (`returnsStock` incluye
  `ANULACION_OPERACION`) y `:1101`.
- La devolución nace solo al registrar a mano (comentario en `:1163`, guarda `isReturnCreditNoteReason`
  → afectado manual en `:1449`). Un 01 sobre un comprobante **electrónico** sigue el camino
  borrador → `send`; en el commit revisado `send` no crea devolución. Para un vendedor, eso era una
  NC de importes y ahora es 403.
- El cambio en curso dice que `assign` «reingresa mercadería» al emitir el borrador: si es así, la
  guarda es correcta y este punto cae; si no, el bloqueo es más amplio que el motivo de D-678
  («reingresa mercadería al kardex»). Impacto hoy bajo: `PSE_ENABLED` está apagado en producción y
  el electrónico no se envía. Confirmar cuál es el comportamiento y que D-678 lo diga.
- El POS (`apps/api/src/pos/pos.service.ts:526`) llama `createCreditNote` con 01, pero
  `POST /pos/sales/:id/void` es solo ADMINISTRADOR (`pos.controller.ts:138`): no se rompe.

## P3 — Fila de Servicios: margen S/ 0 y % espurio por redondeo

- `sales-margin.service.ts:643-652`.
- En la pestaña Servicios (`noCostView`), `marginBase = 0` y el costo es 0: la fila muestra margen
  **S/ 0,00** y % «—». Se lee como «no ganó nada» más que «sin costo registrado»; la franja ya dice
  «sin costo registrado». Considerar `marginPen = null` cuando la base es 0 y no hay costo.
- En «Todas», un pedido solo de Servicios (`onlyNoCost`): la venta de la fila es `signedSubtotal`
  (cabecera) y lo sin costo sale de la suma de líneas. Si difieren por el redondeo al céntimo
  (D-461), queda `marginBase` = ±0,01 con costo 0 → **100 %** (o «—» si es negativo). Es justo el
  síntoma que E-04 quería quitar. Bajo, pero vale un caso de prueba.

## P3 — El 01 que no mueve stock queda solo para el administrador

- `invoicing.service.ts:269`. La guarda es por motivo: un 01 sobre un comprobante manual **sin
  despacho** o sin pedido (`sales-returns.service.ts:303-307` devuelve `null`, no hay devolución)
  también exige ADMINISTRADOR. Probablemente es lo que el dueño quiere (más simple), pero conviene
  que D-678 lo diga.

## P3 — `previewCreditNote` sin la guarda

- `invoicing.service.ts:1149` en adelante. Un vendedor puede pedir la vista previa de un 06/07 (sin
  costo, por D-664). No escribe nada; solo es incoherente con el 403 del registro. La web ya
  deshabilita el motivo (`credit-note-dialog.tsx:109-111`).

## P3 — Alerta de pedido devuelto: casos de borde

- `apps/api/src/sales/order-returns.ts:21-35` y `pedido-detalle-view.tsx:565-585`.
- Correctos al revisar: solo devoluciones `ACTIVE` (la NC anulada revierte la devolución a
  `REVERSED`, `sales-returns.service.ts:540`), solo despachos `ISSUED`, solo líneas con movimiento
  (las `NOOP` de Servicios no cuentan, coherente con `stockByOrderItem`), parciales sumadas por línea
  de despacho y en la unidad de venta en ambos lados (`DispatchItem.qty` y `SalesReturnItem.qty`).
- Bordes que quedan:
  - Pedido con **solo** líneas sin movimiento: `lines.length === 0` → `false` (bien).
  - Pedido con stock devuelto entero y Servicios despachados: dice «todo lo despachado volvió»
    aunque el servicio no vuelve. Texto, no cálculo.
  - Pedido no `FULFILLED` (atendido en parte) con todo lo despachado devuelto: sin aviso (por
    diseño; confirmar con el dueño).
  - El enlace `/devoluciones/:id` lo sirve `GET invoicing/returns/:id`, con roles de clase
    ADMINISTRADOR y VENDEDOR (`invoicing.controller.ts:94`, `:223`): un SUPERVISOR_PLANTA que abra el
    detalle del pedido vería un enlace que da 403.
  - Dos consultas más por detalle de pedido (en paralelo). Si existe un presupuesto de consultas
    sobre el detalle del pedido, revisar que siga verde.

## P3 — Migración

- `apps/api/prisma/migrations/20261019_perf_indexes_cc57/migration.sql`.
- Solo `CREATE INDEX` (sin `CONCURRENTLY`): toma `SHARE` sobre tres tablas mientras se construye;
  con los volúmenes actuales son milisegundos, pero bloquea escrituras de comprobantes, despachos y
  cobros durante ese lapso. Aceptable; correrla con la app tranquila.
- Nombres iguales a los que genera Prisma: `pnpm check:drift` debería seguir coincidiendo con
  `drift-esperado.sql` (verificar en CI).
- `customer_payments_document_id_reversed_at_idx` tiene a `document_id` como prefijo: el índice
  `customer_payments_document_id_idx` queda redundante (más escritura, nada más). Opcional.
- La migración necesita el OK del dueño por nombre (D-460); el comentario dice que lo tiene.

## P3 — `priceWithIgvPen` obligatorio

- `packages/shared/src/schemas/price-list.ts:143-147`, `price-list-import.service.ts:275-281`.
- Una pestaña de `/catalogo/precios/importar` abierta con el bundle anterior a cc57 recibe un 400 de
  Zod. La web actual siempre lo manda (`importar-precios-view.tsx:114`). Sin otros llamadores en
  `apps`, `e2e` ni `scripts`.

## P3 — Coherencia con «Rentabilidad» del comprobante

- `apps/api/src/reports/document-profitability.ts:101-111` calcula `marginPct` sobre `acc.sales`.
  No se verificó si las partes `NO_COST` (Servicios) entran en `acc.sales`; si entran, el margen del
  mismo comprobante difiere entre la pantalla del comprobante y la de «Ventas y margen» tras E-04.
  Revisar antes del UAT.

## Lo que se miró y no dio hallazgo

- `assertStockCreditNoteRole` en `createCreditNote` y `registerCreditNote`: va antes de abrir la
  transacción; el 02 conserva su propia guarda.
- Diálogo de NC: el vendedor arranca en 05 (`DESCUENTO_ITEM`) y ve 01/06/07 deshabilitados con su
  motivo.
- `noCostSalesOf` con NC: el signo se aplica igual a la venta y a lo sin costo; un comprobante con
  base ≤ 0 da % `null` como antes.
- Pestaña de una línea con costo: `noCostSales = 0`, sin cambio.
- `summarizeSalesMargin` lo usan el pie, los grupos por vendedor/cliente (`groupSalesMargin`) y el
  Excel: los tres cambian a la vez. Filas sin margen (`marginPen === null`) siguen fuera de la base.
- Mensaje del segundo 02 (D-677): no deja camino sin salida.

## Respuesta del autor (cc58)

- **P1 (`registerManual` se salta la guarda): corregido.** `registerManualInTx` llama a
  `assertStockCreditNoteRole` para toda NC, así que un borrador 01/06/07 anterior al deploy
  tampoco lo registra un vendedor. Prueba: `credit-note-reasons.db-spec.ts` («un borrador 01 no lo
  registra a mano un vendedor»).
- **P2 (venta − costo ≠ margen en la fila): aceptado**, es D-681; la celda lo explica.
- **P2 (el 01 electrónico):** confirmado que un 01 electrónico no reingresa stock al emitirse; la
  regla va **por motivo**, como la escribió el dueño (01, 06 y 07). Queda dicho en D-678.
- **P3:** el 01 sin despacho también exige administrador (regla por motivo); la vista previa no
  escribe y queda abierta; el enlace a la devolución da 403 a planta, igual que hoy desde el
  comprobante; el índice redundante queda.
