# cc54 corte B (nota de crédito por motivo SUNAT) — revisión de segundo modelo

Revisor: segundo modelo (Sonnet, contexto limpio). Solo lectura sobre `git diff d902e5c9..HEAD`
(rama `cc54-b-nc`, 41 archivos, +4560/-867). No se corrió ninguna suite ni se tocó ninguna base ni
puerto; todo es lectura de código. **No vale como aprobación**: la revisión la cierra el dueño
(AGENTS.md §2 regla 2.3).

Alcance: `invoicing.service.ts` (`planCreditNote`, `registerCreditNote`, `previewCreditNote`,
`registerManualInTx`, `applyReplacementInTx`, `planReplacement`, `assertStillAvailable`),
`credit-note-lines.ts`, `sales-returns.service.ts`, `sales-return-allocation.ts`, `invoicing-net.ts`,
`dispatches.service.ts`, `invoice-dispatch.service.ts`, `collectible-documents.ts`,
`fiscal-import.service.ts`, `recost-engine.ts` (D-662), `inventory.service.ts`
(`moveInvoiceDispatches`), los reportes (`sales-margin`, `sales-by-material`, `document-profitability`,
`receivables-aging`), `packages/shared` (enums y esquemas), el diálogo y `credit-note-form.ts` de la web,
las db-spec/E2E nuevas y los semillas.

Veredicto: **un P1 y cuatro P2**; el resto son P3. El núcleo numérico (`credit-note-lines.ts`: partes
que cierran, rebaja por precio, reparto del monto con resto exacto, cantidad solo de los motivos de
cantidad) está bien razonado y no encontré un error de céntimos. Los lectores de cantidad acreditada y de
vencimiento que revisé quedaron migrados. El P1 es una regresión de la anulación 01 en comprobantes sin
línea de pedido.

## Hallazgos

### P1-1 — el 01 (y su vista previa) revienta si alguna línea del comprobante no viene de una línea de pedido

`invoicing.service.ts` `previewCreditNote` (~L1116, `returnsStock(input.reason) ? planForLines(...)`),
`sales-returns.service.ts` `planForLines` (~L177, `if (line.orderItemId === null) throw ...`) y
`createForCreditNoteInTx` (~L275). Escenario: una venta directa sin pedido (`salesOrderId = null`), o una
factura de un pedido con una línea adicional sin `salesOrderItemId` (flete, servicio: `resolveLines`
admite `salesOrderItemId` opcional). El usuario elige «Anular» (01). La vista previa llama a
`planForLines` con `upToAvailable`, que lanza «no viene de un pedido, no hay despacho que devolver» para
esa línea; el diálogo exige `preview.isSuccess` para habilitar «Registrar» (`ready` en
`credit-note-dialog.tsx`), así que el 01 queda **imposible**. En el registro pasa lo mismo cuando el
pedido existe pero una línea no tiene `salesOrderItemId`. Antes de cc54 el 01 no tocaba stock y esa venta
se podía anular. `createForCreditNoteInTx` sí contempla `salesOrderId === null` (devuelve `null`), pero la
vista previa no, y la línea suelta tampoco. Corrección: para el 01 (`upToAvailable`) las líneas sin
`orderItemId` no devuelven nada (se omiten del plan, y la vista previa las cuenta como «no salió del
almacén»), y la vista previa debe salir antes del `planForLines` cuando el comprobante no tiene pedido.
Prueba que falta: un db-spec del 01 sobre una venta directa y sobre una factura con una línea de servicio.

### P2-1 — la revalidación al registrar un motivo de cantidad no mira el importe

`invoicing.service.ts` `assertStillAvailable` (~L2640-2665). Para 01/02/06/07 solo compara cantidad; para
los demás compara importe. Con el flujo de dos pasos (`createCreditNote` + `registerManual`, que el API
sigue exponiendo, y el camino electrónico), un borrador 07 de toda la línea y una rebaja 05 de la misma
línea se crean los dos con el pendiente completo (`priceCreditLines` ignora los borradores). Si se registra
primero el 05 y después el 07, el 07 pasa (la cantidad no la consumió la rebaja) y la línea queda
acreditada por más de lo que vale: saldo del comprobante negativo y venta neta por debajo de cero. El
camino de un paso no tiene el problema (calcula bajo el bloqueo). Corrección: en la rama de cantidad
comprobar también `item.totalPen <= original.totalPen − (byQty + byAmount)` de las otras notas vivas;
y agregar el par «borrador 07 + 05 registrada + registro del 07» a un db-spec.

### P2-2 — el 02 cambia el cliente del pedido y lo puede hacer un VENDEDOR; el resto de entidades quedan con el cliente viejo

`invoicing.service.ts` `applyReplacementInTx` (~L1870-1900) y `invoicing.controller.ts` (la clase es
`@Roles(ADMINISTRADOR, VENDEDOR)`; las rutas nuevas no restringen el rol). `planCreditNote` solo hace
`assertSellerAccess` sobre el comprobante afectado, no sobre el cliente de destino. Un vendedor puede
registrar un 02 con cualquier `customerId` activo y mover el pedido y su venta a ese cliente. Es la
primera ruta del sistema que escribe `sales_orders.customer_id`, sin control de rol ni de cartera, y la
vista previa devuelve además el nombre de cualquier cliente. Además la cotización de origen
(`quotations.customer_id`), y los comprobantes del pedido que no son factura ni boleta (guías, el filtro
`others` de `planReplacement` solo mira `FACTURA`/`BOLETA`) conservan el cliente viejo. Corrección
sugerida: restringir el 02 a ADMINISTRADOR (o exigir acceso del vendedor al cliente de destino) y decidir
qué hacer con la cotización (D-nnn). Las acciones de auditoría nuevas `invoicing.credit-note.replacement`
y `sales.order.customer-change` no tienen etiqueta en `packages/shared/src/audit-labels.ts`: el
«Historial» las muestra crudas.

### P2-3 — la regla dura 17 pide un par concurrente por camino nuevo y no se agregó

El camino `registerCreditNote` toma comprobante → despachos (los del devuelto, y los que el 02 lleva al
reemplazo, leídos antes del bloqueo) → pedido → bobinas/saldos, y escribe `dispatches.invoice_id`,
`sales_orders.customer_id` y un comprobante nuevo. `lock-order.db-spec.ts` no cambió. Faltan al menos: 02 en
paralelo con un despacho/vínculo de factura sobre el mismo pedido, y dos NC distintas sobre el mismo
comprobante (una de cantidad y una de precio). El orden leído es correcto (verifiqué `lockDocuments` y
`lockWithAffected`); lo que falta es la prueba que lo fija.

### P2-4 — una db-spec escribe en `local-data/` y compara conteos

`credit-note-reasons.db-spec.ts` (~L435-470, «medición»): `writeFileSync(.../local-data/cc54/medicion-nc-devolucion.json)`
falla con `ENOENT` en un checkout o CI donde `local-data/cc54/` no existe (la carpeta está ignorada y nace
vacía en cada worktree), y `expect(oneStep.queries).toBeLessThan(twoSteps.queries)` es una afirmación de
rendimiento dentro de una suite de corrección. Una prueba no debe escribir fuera del árbol versionado ni
depender de una carpeta ignorada. Sacar la medición a un script aparte, o crear el directorio y no escribir
en la suite normal.

## P3

- **P3-1 — el 02, si se deshace, deja el pedido a medias.** `fiscal-import.service.ts` (~L150): se impide anular
  la NC 02 con el reemplazo vivo, bien. Pero una vez anulado el reemplazo, el despacho queda sin comprobante
  declarado, el pedido sigue con el cliente nuevo y, si se anula la NC 02, el comprobante original vuelve a
  estar vivo con el cliente viejo sobre un pedido del cliente nuevo. No hay camino de retorno del cliente del
  pedido. Documentarlo o bloquear anular la NC 02 una vez movido el pedido.
- **P3-2 — `replacesDocumentId` es único.** `applyReplacementInTx` traduce todo `P2002` al mensaje «ya hay un
  comprobante con el número…»; si el afectado ya fue reemplazado por otra vía, el mensaje engaña.
- **P3-3 — un 13 retrofechado puede no tener efecto.** `effectiveDueDate` ordena por fecha de emisión de la nota y
  luego por creación: un administrador que registra un 13 con fecha anterior a otro 13 vivo crea una nota
  de importe 0 que no cambia nada, y `planCreditNote` solo compara contra el vigente. Poca probabilidad.
- **P3-4 — el 03 y el 13 se aceptan sobre un comprobante ya acreditado por completo** (`zeroCreditLines`
  no mira lo acreditado). Inocuo, pero corregir la descripción o el vencimiento de una factura anulada
  por NC es ruido en el historial.
- **P3-5 — el 02 entre meses mueve el costo.** `Dispatch.invoice_id` pasa al reemplazo: el costo del despacho
  sale del mes del comprobante original y entra en el del reemplazo; Ventas y margen marca «no comparable»
  el pedido si el reemplazo cae fuera del rango, pero el mes del original queda con venta sin costo. Es
  consecuencia de D-655; vale una línea en la nota del reporte.
- **P3-6 — electrónico.** El 01 sobre un comprobante electrónico no genera DEV- (solo 06/07 se bloquean en
  `send`) y un 03/13 de importe 0 se manda tal cual al PSE; Nubefact está apagado, pero no hay guarda.
- **P3-7 — orden por vencimiento.** `list-orderings.ts` ordena por la columna `due_date` cruda: no ve el 13
  ni la corrección de fecha de emisión (`updateManualIssueDate` mueve el vencimiento base pero no el de una
  NC 13 viva).
- **P3-8 — cobertura E2E recortada.** `importe-importado-d169.spec.ts` perdió la comprobación de que dos NC
  parciales suman el importe del papel (hoy solo la cubren los unitarios); la prueba sigue llamándose «el importe
  del papel manda de punta a punta». El db-spec del 05+07 cubre una parte, no el caso de dos partes con IGV
  de 5 decimales.
- **P3-9 — `unitPricePen` del 05 con precio casi cero.** `priceCreditLines` cae a `exactRest` si
  `recomputed.total > rest.total`, también cuando el precio nuevo no es cero (acredita la línea entera por un
  redondeo). Borde de céntimos.

## Verificado sin hallazgo

- Importes: `qtyCreditLines` (parte que cierra con rebaja previa vía `rebated`), `priceCreditLines`,
  `amountCreditLines` + `prorate` (la cabecera suma exactamente el monto; el resto va a la línea mayor) y
  `zeroCreditLines`. Todo en `Decimal`; la web usa `Number` solo para el correlativo entero.
- Lectores de «cantidad acreditada»: `invoicing-net` (`mergeCredits` deja el importe de las rebajas y no
  su cantidad), `dispatches.service`, `invoice-dispatch.service`, `findOne` (`creditedQty`), los tres SQL
  de `sales-by-material` (`SIGNED_QTY`), `sales-margin` y `document-profitability`
  (`QTY_REDUCING_CREDIT_REASONS` equivale a `QTY_CREDIT_NOTE_REASONS`). El netting de importes de las rebajas
  en el `PartLedger` de facturar no sobrefactura: `closingPartTotals` cae al recálculo si el resto se aleja
  más de un céntimo.
- Vencimiento del 13: `findOne`, listado, `receivables`, `receivables-aging`, cobranzas y los Excel usan
  `effectiveDueDate`/`dueDateOf`; anular la NC lo devuelve sin escribir nada.
- D-662: `firstNegativeDate` coincide con `assertNoNegativeAtDate`; el saldo final sigue siendo el último punto.
- 01 con despacho: `onlyAffected`/`upToAvailable`, DEV- al costo efectivo, costo imputado a la NC en Ventas y
  margen y en la rentabilidad del comprobante; anulación de la NC revierte la devolución sin importar el motivo.
- Reemplazo 02: una sola transacción; cobros, otras NC, número duplicado, pedido anulado, otros comprobantes
  del pedido, tipo de cliente; el despacho pasa por la puerta del kardex; sin movimiento de stock.
- No se leyó ningún `.env*`; el semilla no escribe `inventory_movements` ni imprime credenciales.

## Resumen

| #          | Sev. | Dónde                                                            | Resumen                                                                                                                                                             |
| ---------- | ---- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1       | P1   | `previewCreditNote` / `planForLines` / `createForCreditNoteInTx` | el 01 falla (y su vista previa) con líneas sin pedido y en ventas directas                                                                                          |
| P2-1       | P2   | `assertStillAvailable`                                           | un motivo de cantidad registrado después de una rebaja sobrepasa lo que queda de la línea                                                                           |
| P2-2       | P2   | `applyReplacementInTx` / controlador                             | el 02 reasigna el cliente del pedido sin control de rol; cotización y guías con cliente viejo; etiquetas de auditoría faltan                                        |
| P2-3       | P2   | `lock-order.db-spec.ts`                                          | regla 17: falta el par concurrente del camino nuevo                                                                                                                 |
| P2-4       | P2   | `credit-note-reasons.db-spec.ts`                                 | la suite escribe en `local-data/` (ENOENT) y afirma conteos de consultas                                                                                            |
| P3-1..P3-9 | P3   | varios                                                           | deshacer el 02, `replacesDocumentId`, 13 retrofechado, 03/13 sobre acreditado, costo entre meses, electrónico, orden por vencimiento, cobertura D-169, borde del 05 |

---

## Qué se hizo con cada hallazgo (sesión cc54)

- **P1, 01 con una línea sin pedido (flete o servicio), o en una venta directa:** corregido. El plan de la devolución
  devuelve vacío en esas líneas para el 01, y el 01 de un comprobante sin pedido no genera devolución. db-spec «01 con
  una línea sin pedido».
- **P2, revalidación por importe en los motivos de cantidad:** corregido. `assertStillAvailable` mide el importe en
  todos los motivos, con un céntimo de holgura por la parte que cierra (D-265).
- **P2, el 02 por un vendedor; cotización, guías y etiquetas de auditoría:**
  - solo ADMINISTRADOR, en el API y en la web;
  - lo bloquean las guías vivas del pedido;
  - la cotización conserva su cliente: es su historia;
  - etiquetas nuevas para `invoicing.credit-note.replacement` y `-replacement-undone`; el cambio de cliente usa la
    acción que ya existía, `sales.order.customer`.
- **P2, el par de la regla 17:** corregido. Par nuevo en `lock-order.db-spec`: «NC 01 en un paso × revertir su
  despacho», sin deadlock ni doble devolución.
- **P2, la db-spec de medición:** crea su carpeta antes de escribir.
- **P3:**
  - deshacer un 02, el reemplazo único, la rebaja de S/ 0 y el monto de la 04: corregidos (ver la autorrevisión);
  - el 13 retrofechado sin efecto, 03 y 13 sobre un comprobante acreditado, el 02 entre meses y el orden por
    vencimiento: anotados;
  - la E2E de D-169: la parte de NC parciales queda en las pruebas unitarias (`credit-note-lines.spec.ts`,
    `invoicing-parts-drafts.spec.ts`).
