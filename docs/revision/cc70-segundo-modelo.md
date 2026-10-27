# Revisión de segundo modelo — cc70 (D-730)

Revisor: segundo modelo (Sonnet), contexto limpio, solo lectura. No corrí E2E, db-specs ni builds; revisé el diff `405e44e3..HEAD` (6 archivos) y los consumidores de la devolución y de la fecha de la NC.

Resultado corto: **sin P0 ni P1.** Un P2 real (el detalle de la DEV- miente tras mover la fecha de la NC) y varios P3.

## P0

Ninguno.

## P1

Ninguno. Lo comprobado:

- `invoicing.service.ts` (`updateManualIssueDateInTx`): al quitar el 409 siguen en pie las cotas de siempre (`assertIssueDate`: rol, no futura, piso histórico; NC no antes del comprobante que acredita). Solo se actualizan `fiscal_documents.issue_date`, el registro de cambio de fecha y la auditoría; no se toca `sales_returns` ni kardex.
- Anulación de la NC (`reverseForCreditNoteInTx`): revierte con `inventory.reverse` a la fecha de hoy y no lee `issue_date`; mover la fecha antes no la afecta.
- Ventas y margen (`sales-margin.service.ts` ~272 y ~352), rentabilidad por documento (`document-profitability.service.ts:118`) y ventas por material (`:458`) atan el costo de la devolución a la NC por `credit_note_id` / `credit_note_item_id`, no por `sales_returns.operation_date` ni por la fecha del movimiento. El costo viaja con la NC al mes nuevo, como dice D-730; la excepción de «no comparable» (`NOT EXISTS ... ACTIVE`) también sigue a la NC.
- El reparto por despacho (`asOf = note.issueDate`) solo corre al registrar la NC; ningún camino lo recalcula después, así que cambiar la fecha no deja un plan incoherente con lo grabado.
- El disparador del bloqueo (`redateDispatches` con devolución vigente) es independiente y se conserva.

## P2

### P2-1. El detalle de la DEV- afirma cosas falsas cuando la fecha de la NC se movió

- `apps/web/src/app/(app)/devoluciones/[id]/devolucion-detalle-view.tsx:83-89` y `:136-139`; `packages/shared/src/schemas/invoicing.ts:1761-1769`.
- `creditNoteDate` se lee en vivo de `fiscal_documents.issue_date` (`sales-returns.service.ts:799`), pero desde D-730 deja de ser la fecha con que se grabó la DEV-. La vista asume que `item.operationDate > creditNoteDate` significa «entró por un despacho posterior a la nota» y que `operationDate === creditNoteDate` significa «la de la nota».
- Escenario A (el del propio E2E): NC de hoy 05/10 con DEV- 05/10; se corrige la NC a 30/09. Los ítems (05/10) pasan a ser `> creditNoteDate` y el detalle muestra «La devolución entra al almacén el 05/10 (fecha del despacho DSP-…), después de la fecha de la NC», cuando el despacho es anterior y la entrada se hizo en la fecha original de la nota. Aviso falso sobre un documento de kardex.
- Escenario B: la NC se mueve a una fecha **posterior** a la DEV-. No hay `lateNotices`, y la tarjeta Fecha dice «La de la nota» aunque la DEV- tiene otra fecha.
- El E2E (`fecha-nc-con-dev-cc70.spec.ts`) comprueba el diálogo y los datos, no esta pantalla, por eso no lo detecta.
- Propuesta: en la tarjeta, comparar `r.operationDate` con `r.creditNoteDate` y si difieren (en cualquier sentido) decir «La nota es del X; la devolución se grabó el Y» sin atribuir la causa a un despacho; limitar `lateReturnEntryNotice` a ítems cuya fecha sea igual a la de su despacho (`dispatchDate`) y mayor que la nota. Alternativa mínima: guardar/mostrar la fecha original de la NC en el DTO. Sumar una aserción de UI/E2E sobre `/devoluciones/<id>` tras el cambio.

## P3

### P3-1. El aviso del diálogo usa la fecha de cabecera, y la DEV- puede tener varias fechas

`comprobante-detalle-view.tsx` (alert `issue-date-sales-return`): usa `salesReturn.operationDate`, que es la más tardía de las partes (cc69: partes con despacho posterior entran en la fecha del despacho, las demás en la de la NC). El texto «se queda el dd/mm» es exacto para la cabecera pero ignora que otras partes están en una fecha anterior. Además `.slice(0, 5)` quita el año: una DEV- de otro año (NC de enero corregida en diciembre del mismo año fiscal, o cruce de año) se lee mal. Propuesta: mostrar la fecha completa o, si hay varias, «las fechas de su kardex no cambian».

### P3-2. Auditoría con una sola fecha de la DEV-

`invoicing.service.ts` (`after.salesReturnDate`): igual que arriba, solo la cabecera. Aceptable; documentarlo.

### P3-3. Pruebas unitarias con dobles débiles y sin caso de rol

`invoicing-issue-date-redate.spec.ts`: el doble de `findFirst` devuelve siempre la DEV-, así que no prueba que la consulta filtra por `status: 'ACTIVE'` y `creditNoteId` (si alguien la rompe, el test pasa). No hay caso de un VENDEDOR intentando corregir la NC con devolución (el control de rol sigue en `assertIssueDate`, pero el comportamiento nuevo no lo cubre) ni de una DEV- `REVERSED` (NC anulada: se rechaza antes por estado, vale un caso que lo fije).

### P3-4. El db-spec no cubre la NC con despacho posterior

`sales-returns.db-spec.ts` (cc70): solo el caso simple, DEV- de un despacho. No cubre una DEV- con partes en dos fechas (cc69) ni mover la NC a una fecha anterior al despacho de origen. El invariante «kardex sin filas nuevas» es sólido para el caso probado; falta el caso donde `creditNoteDate` cruza con `operationDate` de los ítems (el que dispara P2-1).

### P3-5. Documentación fuera del diff

El diff no incluye `docs/ARQUITECTURA.md` §0.2 (D-730, modificación de D-645) ni los comentarios `D-645` residuales: `invoicing.service.ts:1363` y `:1842` («la fecha de la NC es la del reingreso al kardex») ya no son del todo ciertos. Confirmar que el cierre los actualiza.

### P3-6. Mensaje de aviso solo con `status === 'ACTIVE'`

Correcto hoy (una NC anulada no se corrige), pero deja el aviso acoplado a un estado que el endpoint ya excluye; sin riesgo, solo nota.
