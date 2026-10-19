# Revisión de segundo modelo — cc58 corte A

Alcance: `git diff origin/main..cc58-a` (un commit, 21 archivos). Revisor: segundo modelo, contexto limpio (no vale como revisión del dueño). Se corrieron los unitarios tocados (86 verdes: `invoicing-credit-note`, `report-rows`, `sales-margin.service`, `order-returns`, `price-list-import`). No se corrieron db-specs ni E2E.

Veredicto: sin P0 ni P1. La migración, el esquema y las siete decisiones están implementadas como se describieron. Hay dos huecos de rol (P2), un cambio de significado visible en la tabla (P2) y detalles menores.

## P0

Ninguno.

## P1

Ninguno.

## P2

### P2-1. Un borrador 01/06/07 que ya existe sigue siendo emitible por un vendedor (el rol solo se mira al crear)

- `apps/api/src/invoicing/invoicing.service.ts:2523` (`send`) y `:2457` (`correct`, que copia `creditNoteReason` de la NC rechazada a un borrador nuevo).
- Escenario: antes del deploy un vendedor dejó un borrador de NC 01 (o 07). Tras el deploy, ese vendedor pulsa «Emitir»: `send` solo exige `assertOwnership` y la emisión (`assign` → devolución → reingreso al kardex) corre sin pasar por `assertStockCreditNoteRole`. Lo mismo con `correct` sobre una NC 01/06/07 rechazada: crea un borrador nuevo sin el control de rol. Es el mismo reingreso de mercadería con costo que D-678 quiere reservar al administrador.
- Corrección sugerida: llamar `assertStockCreditNoteRole(actor, document.creditNoteReason)` en `send` (cuando el documento es NC) y en `correct`; o, mínimo, dejar documentado que los borradores previos al deploy los emite un administrador. Añadir un caso al spec de rol.

### P2-2. El margen de la fila ya no es «venta − costo» en las filas con venta sin costo (cambio de significado)

- `apps/api/src/reports/sales-margin.service.ts:~680` y `:~704`; `packages/shared/src/report-rows.ts:~251`; consumidores: `apps/api/src/reports/reports-xlsx.ts:265-266` (hoja «Por pedido» y documentos `:359-360`), `ventas-margen-view.tsx:674-684`, `:733`, `:858`.
- Escenario: pedido con venta 1300, 100 de Servicios, costo 950. Antes la fila decía margen 350; ahora dice 250 (y 20,83 %). Quien lee la tabla o el Excel ve `Venta − Costo ≠ Margen` en la misma fila sin ninguna pista. Para las filas solo de Servicios, el margen pasa de la venta entera (100 %) a 0 con % nulo. Es el efecto buscado por el dueño (D-681), pero ninguna cabecera ni nota lo explica, y el DTO nuevo `noCostSalesPen` no se muestra en la fila ni en el Excel.
- Corrección sugerida: título/tooltip de la columna «Margen» («sobre la venta con costo registrado, sin Servicios ni “Sin línea”») y, si el dueño lo quiere, una columna «Venta sin costo» en el Excel «Por pedido». El pie ya cuadra con la franja (lo prueban los tests).

### P2-3. La pestaña de Servicios deja `marginPen` de la fila en `−costo` (0 en la práctica) y los documentos en 0 — verificar con el dueño

- `sales-margin.service.ts:~646-650` (`noCostView` → `docNoCostInView = docSalesInView`).
- Escenario: en la pestaña «Servicios» toda la venta es «sin costo», así que cada fila queda con margen 0,00 y % `—`. Coincide con los totales de esa pestaña (`marginBase = 0`), por lo que es coherente, pero antes la fila mostraba margen = venta. Se menciona para que el dueño lo confirme en el UAT; no es un defecto de cálculo.

## P3

### P3-1. Índice redundante

- `apps/api/prisma/schema.prisma` (`CustomerPayment`): `@@index([documentId])` queda cubierto por `@@index([documentId, reversedAt])`. Costo de escritura menor en una tabla chica; se puede retirar el viejo en una migración futura. Nombres de índice del esquema y del SQL coinciden con el nombre por defecto de Prisma (`fiscal_documents_issue_date_idx`, `dispatch_items_movement_id_idx`, `customer_payments_document_id_reversed_at_idx`), así que `check:drift` no debería reportar diferencia nueva. Los `CREATE INDEX` sin `CONCURRENTLY` toman un bloqueo de escritura corto; las tres tablas son chicas en producción.

### P3-2. El texto de la UI del vendedor para el 02/01

- `credit-note-dialog.tsx:106-111`: para un vendedor, el 01 en un comprobante emitido aquí queda deshabilitado con «Devuelve mercadería al almacén…». Es correcto, pero el 01 es también el camino de anulación por NC cuando ya no cabe la baja (`voidPathFor`); el vendedor queda sin camino y sin indicación de a quién acudir. Sugerido: añadir «pídeselo a un administrador».
- El valor inicial `DESCUENTO_ITEM` para el vendedor es correcto (no está deshabilitado para ningún rol) y el `useEffect` con `initialReason` en las dependencias no provoca reinicios espurios (solo reinicia con el diálogo cerrado).

### P3-3. Pruebas

- `invoicing-credit-note.spec.ts`: el test de rol falla sin el fix (sin `assertStockCreditNoteRole` el `registerCreditNote` del vendedor avanzaría al esquema/plan en lugar de lanzar «la registra un administrador»). Bien. No cubre `send`/`correct` (P2-1).
- `price-list-import.spec.ts`: la prueba del esquema es la que muere sin el fix. No hay prueba de que el servicio rechace una fila cuyo `priceWithIgvPen` no cuadra con `afterValuePen` ahora que el chequeo es incondicional (había una antes de cc58 sobre el caso opcional; conviene un caso explícito de discrepancia).
- `credit-note-reasons.db-spec.ts` (mensaje del segundo 02, pedido FULFILLED con `returns`) no se corrió en esta revisión (db-spec); sus aserciones de texto coinciden con el mensaje del código (`no se permite`, `nota de crédito 01`, `vuelve a emitir`).
- `order-returns.spec.ts` usa dobles que fijan la forma de las consultas; no prueba el filtro contra datos reales (lo cubre el db-spec de cc54 ampliado).

### P3-4. `orderReturns` agrega 2 consultas al detalle de pedido

- `sales-orders.service.ts:3604-3624`. Van dentro del `Promise.all`, sin bloqueos; no hay test de presupuesto de consultas sobre `findOne` de pedidos (la búsqueda no encontró uno), así que no rompe nada. Si el detalle del pedido tiene presupuesto en otro lado, actualizarlo.

## Revisado sin hallazgos

- Otros llamadores de `createCreditNote` con stock: `pos.service.ts:526` (anulación de venta de mostrador) corre con `@Roles(ADMINISTRADOR)` en `pos.controller.ts:137`, no se rompe. Helpers E2E que crean NC 01 usan sesión de administrador.
- `transportSuggestions` (D-679): solo comentario, sin cambio de comportamiento.
- `summarizeSalesMargin` con `noCostSalesPen` ausente (`?? '0'`) mantiene compatibilidad con dobles que no lo traen; el único otro consumidor (`sales-margin-groups.ts`) usa `summarizeSalesMargin`, por lo que los grupos por vendedor/cliente heredan la base nueva sin cambios.
- Mensaje del segundo 02: cubre los dos casos (reemplazo vigente y anulado) y nombra el camino 01 + volver a emitir.
- Importación de precios: el web ya envía `priceWithIgvPen` (DTO de fila es `string` no nulo); sin llamadores internos que omitan el campo.

## Respuesta del autor (cc58)

- **P2-1 (rol solo al crear): corregido.** `send` y `correct` llaman a `assertStockCreditNoteRole`
  para una NC 01/06/07 cuando quien emite no es administrador. Prueba: `invoicing-credit-note.spec.ts`
  («emitir el borrador de una NC que devuelve stock, tampoco»).
- **P2-2 (el margen de la fila ya no es venta menos costo): aceptado y avisado.** Es la decisión
  del dueño (D-681, base de D-409 también por fila). La celda de margen lo explica con un
  `title` cuando la fila tiene venta sin costo registrado. Queda en el UAT.
- **P2-3 (pestaña Servicios con margen 0): aceptado.** Coherente con la franja; va al UAT.
- **P3:** el índice simple de `customer_payments(document_id)` queda; quitarlo es otra migración.
  El motivo bloqueado ahora dice «pídeselo a un administrador». La prueba del rechazo por
  `priceWithIgvPen` que no cuadra ya existía (`price-list-import.spec.ts`, «el navegador manda
  1.0000»). Las dos consultas de `orderReturns` van en paralelo con las demás del detalle; no hay
  presupuesto de consultas sobre ese detalle.
