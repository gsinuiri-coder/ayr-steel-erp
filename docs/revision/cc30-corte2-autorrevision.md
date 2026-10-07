# cc30, corte 2: autorrevisión (no es un pase cruzado)

> **Autorrevisión (no es un pase cruzado).** La hizo un subagente que no leyó el handoff de
> implementación de la sesión. Es una lista de riesgos, no una aprobación. No reemplaza la revisión
> del segundo modelo ni la del dueño.

- Alcance: `git diff origin/cc30-bloqueos-documentos...HEAD -- apps` en la rama `cc30-corte2`
  (commits `e174d83c`..`039617ef`; se ignoró el merge de `ci.yml`).
- Contexto leído: `docs/analisis/cc30-matriz-bloqueos.md` (cruces C1–C12) y el orden canónico de
  D-470/D-471: comprobante → despacho → cotización → pedido → OP → reserva temporal → reserva →
  inventario (compra y corte en una rama aparte).
- Método: lectura del diff y de los llamadores de cada toma (`lockDocuments`, `lockOrder` de ventas
  y de planta, `lockOrderDrafts`, `lockAnnulledForReactivation`), además del estado de la puerta
  (`lockStateOf`) en los caminos compuestos. **No se corrió ningún test**: había una corrida de
  `test:db` usando la base local, y tampoco se corrieron unitarios ni typecheck.

## Resumen

No encontré P0 ni P1. Ninguna toma nueva pide `NOWAIT` sobre filas de otra transacción en el flujo
normal de POS, V9 o addItems: en esos tres casos lo que llega fuera de orden son filas que la misma
transacción acaba de insertar. Tampoco cambian los mensajes cuando el id no existe. Quedan dos P2 de
cobertura y varios P3: carreras estrechas que antes esperaban y ahora salen con 409, un ciclo
residual que existía antes del corte y detalles de tests.

---

## P0

Ninguno.

## P1

Ninguno.

## P2

### P2-1. Los cruces C6, C9 y C11, y los arreglos V17 y F8, no tienen par contra la base

- `apps/api/src/inventory/lock-order.db-spec.ts:1413-1499`: el corte solo suma C7 y C8.
- Sin par concurrente quedan:
  - **C6**: `RoofingProductionService.createFromSalesOrder`, `roofing-production.service.ts:1892-1902`,
    contra `SalesOrdersService.cancel` y `completeReservation`.
  - **C9**: `purchase-received-edit.service.ts:122`, ahora con `FOR NO KEY UPDATE`, contra partir
    una bobina de esa compra o recibir su corte.
  - **C11**: los advisory locks ordenados de `quotation-import.service.ts:853-859`.
  - **V17**: liberar la reserva (`sales-orders.service.ts:2660-2682`) contra crear una OP desde esa
    reserva.
  - **F8**: descartar un borrador (`invoicing.service.ts:1552`) contra emitirlo.
- Escenario: una regresión futura que vuelva a tomar reserva → pedido, o `FOR UPDATE` sobre la
  compra, no la detecta ningún test. Los unitarios de C9 y C11 solo cuentan llamadas: el de C11
  (`quotation-import-coil.spec.ts:865`) pasa de 1 a 2 `$executeRaw` y no verifica el orden de las
  claves. El mock de `purchase-received-date-fix.spec.ts` devuelve `[]` y no afirma que la compra
  se tome antes que `lockInOrder`. C9 depende de una regla de Postgres que no se ve en el código: un
  índice único parcial no cuenta como «clave», y por eso `NO KEY UPDATE` no choca con el
  `KEY SHARE` de la FK.
- AGENTS §3 regla 17 pide que «un camino nuevo que mueva inventario suma su par ahí». C6 y C9 son
  caminos reordenados que mueven inventario.
- Propuesta:
  1. Sumar a `lock-order.db-spec.ts` los pares C6 (crear las OP del pedido × anular el pedido) y C9
     (editar la compra recibida × partir una bobina de esa compra). C9 es el que depende de la
     semántica de Postgres.
  2. En los unitarios, afirmar el orden: la compra antes de `lockInOrder` en la CLI de fecha, y las
     claves del importador ordenadas.
  3. Opcional: un par V17 o F8, o dejarlo anotado en PROGRESO como riesgo aceptado.

### P2-2. El supuesto de C9 se rompe si alguien agrega un índice único total sobre `purchases`

- `purchase-received-edit.service.ts:116-122` y `purchase-received-date-fix.ts:49-58`.
- Hoy funciona porque la unicidad del comprobante es un índice **parcial**
  (`purchases_supplier_document_live_key ... WHERE status <> 'CANCELLED'`, migración
  `20260907090000`). Postgres no lo cuenta como clave, así que el `UPDATE` de la edición, que puede
  cambiar `supplier_id`, `doc_type`, `series` y `number` (`:1391-1398`), sigue en
  `NO KEY UPDATE`.
- Escenario: si mañana se agrega un `UNIQUE` total sobre alguna de esas columnas, el `UPDATE` sube
  a `FOR UPDATE` sin que nada falle. C9 reaparece al final de la edición, con bobinas en mano,
  contra el `KEY SHARE` de partir una bobina.
- Propuesta: dejar el supuesto escrito en el comentario de `:116-121`, que hoy no lo nombra. Mejor
  aún, convertirlo en un test: el par C9 contra la base del P2-1 lo cubre.

## P3

### P3-1. Carreras estrechas que antes esperaban y ahora dan 409 (`NOWAIT`)

Son las consecuencias previstas del diseño («lo que nació en el medio va con `NOWAIT`»). Las dejo
anotadas porque el usuario sí las nota:

- **Anular pedido**, `sales-orders.service.ts:2441-2446`. Una OP o un borrador que nace entre
  `cancelLockPlan` (sin bloqueo) y la toma del pedido se pide con `NOWAIT` en la relectura. Una OP
  recién creada ya hizo commit, así que normalmente no choca. Pero si en ese instante planta la
  tiene tomada sin `parent` (por ejemplo `setPriority`, `roofing-production.service.ts:1842`, o un
  borrador de corte), la anulación sale con 409 en vez de esperar. Antes la OP no se bloqueaba:
  solo el `updateMany` implícito.
- **Reactivar o traer un comprobante**, `fiscal-import.service.ts:343`, `:662` y `:1026`, y
  `move-to-order.service.ts:480`. Un borrador nacido entre `draftIdsOn` y la toma del pedido, que
  en ese momento se esté emitiendo (`assignInTx` lo tiene), da 409.
- **Varios despachos en F4/F5**, `dispatches.service.ts:877`. Las reservas del despacho N llegan
  con saldos ya en mano y van con `NOWAIT`. Verifiqué que todos los que hoy toman reservas toman
  antes el pedido: `releaseReservation`, las altas de OP, `updateItemCoilInTx`,
  `completeReservation`, `restoreReservation`, `lockOrder` de planta con `own`, y `parent` +
  reservas en `roofing:1022` y `:2539`. Como F4/F5 ya tiene el pedido, el `NOWAIT` en la práctica
  no salta.
- **V24 (barrido de importados)**, `sales-order-edits.service.ts:403-407`. Desde la segunda línea
  de un pedido, las reservas de la línea van con `NOWAIT`. Es una CLI de ventana y la matriz ya lo
  anota.
- Propuesta: nada en código. Una línea en PROGRESO o en el UAT («un 409 de "vuelve a intentarlo"
  al anular un pedido mientras planta toca su OP es esperado»).

### P3-2. Ciclo residual F4 × F5 sobre el mismo comprobante, por FK (anterior al corte)

- `invoice-dispatch.service.ts:316` y `:391/:416`. En F4 por HTTP (`executeForInvoice`), el orden
  es: pedido X (sin tomar antes el comprobante; el punto 12 de la matriz), luego inventario, y al
  final `linkInvoiceInTx`, que escribe `dispatches.invoice_id`. La FK toma `KEY SHARE` sobre el
  comprobante, después del pedido y del inventario.
- En F5 (`updateManualIssueDateInTx` → `redateInTx`), el orden es: comprobante `FOR UPDATE` →
  despachos → pedido.
- Escenario: F4 y F5 sobre la misma factura a la vez forman un ciclo (pedido ↔ comprobante), y
  Postgres aborta una con un 500. La puerta y el centinela no lo ven porque es un bloqueo implícito.
  No lo introduce el corte 2, pero queda fuera de D-471.
- Propuesta: en `executeInTx`, tomar el comprobante por la puerta antes que el pedido
  (`lockDocuments(tx, { fiscalDocuments: [invoiceId], salesOrders: [...] })`, leyendo
  `salesOrderId` antes sin bloqueo). Dentro de F5 y de la CLI ya lo tiene la misma transacción, así
  que no cuesta nada. Si se deja para otro corte, anotarlo en la matriz como residuo con su
  escenario.

### P3-3. El estado de la puerta no se entera de un `ROLLBACK TO SAVEPOINT`

- `document-locks.ts:120-160` (y el mismo patrón de `lockCoilRows`). `state.documents` recuerda
  como tomadas filas cuyo bloqueo Postgres suelta al volver a un savepoint. Una toma posterior las
  considera ya tomadas (`fresh` vacío) y no las vuelve a bloquear.
- Hoy no muerde: en los dos importadores con `SAVEPOINT` (`quotation-import.service.ts:862-973`,
  `purchase-import.service.ts:402-418`) ningún camino dentro del savepoint usa `lockDocuments`, y el
  corte 2 no agrega ninguno. Es una trampa latente para el próximo que lo haga.
- Propuesta: una línea en el comentario de `lockDocuments` («no usar dentro de un `SAVEPOINT`
  revertible») o un centinela.

### P3-4. Lo que el centinela no ve

- `document-locks.sentinel.spec.ts:24-28`:
  - No reconoce una tabla calificada con esquema (`FROM public."sales_orders" … FOR UPDATE`).
  - No ve `$queryRawUnsafe` armado por concatenación, porque corta en `;` y en el backtick.
  - No ve bloqueos implícitos por FK (el caso de P3-2).
- El encabezado ya admite lo último. Propuesta opcional: aceptar `(\w+\.)?"?table"?` en el patrón,
  o documentar que no se califica el esquema.

### P3-5. Lecturas y tomas que cambiaron sin cambiar el resultado (verificado, sin acción)

Revisé las conversiones de `$queryRaw` crudo a Prisma; ninguna cambia el resultado:

- `lockQuotationHead`, `QuotationsService.lockQuotation`, `lockOrder` de ventas,
  `SalesOrderEditsService.lockEditable`, `assignInTx`, `invoicing.createInTx` (`totalPen`),
  `fiscal-import` (estado del pedido y `OrderRow`) y `move-to-order` (`OrderRow`). Devuelven los
  mismos campos y tipos: `Date` para las columnas `date`, `Prisma.Decimal` (`toString()` igual al
  crudo) y enums con los mismos literales.
- `QuotationsService.lockQuotation` declaraba `sellerId: string` y ahora `string | null`. El schema
  ya era `String?` (`schema.prisma:1574`), así que solo corrige el tipo.
- Con un id inexistente, los mensajes siguen igual: «Pedido no encontrado», «Cotización no
  encontrada», «Despacho no encontrado», «Comprobante no encontrado» y «Reserva no encontrada».
  `cancelLockPlan`, el `link` de `reverseInTx`/`releaseReservation` y `owner` en las altas de OP
  degradan a «no bloquear nada» y dejan que la lectura posterior lance el 404 de siempre. Un id que
  no es uuid sigue fallando igual en el cast `::uuid[]`.
- La purga ahora bloquea por id en vez de por `seq` (`quotation-purge.ts:182-188`). El conjunto es
  el mismo y el orden sigue siendo determinista.
- Lo único que de verdad cambia de comportamiento es **intencional**: `discardDraft`
  (`invoicing.service.ts:1552`) ahora devuelve 400 («Solo se descarta un borrador…») donde antes
  borraba un comprobante que se acababa de numerar (D-474). `releaseReservation` ahora espera al
  pedido y a sus OP vivas.

### P3-6. Cosas menores

- `lockAnnulledForReactivation` (`fiscal-import.service.ts:960-973`) bloquea ahora **todos** los
  borradores de los pedidos, también las guías en `DRAFT` y también los del pedido de origen en
  D-381, y además el pedido aunque el comprobante sea `ISSUED_HERE` (que se rechaza más abajo). Es
  más espera, no un cambio de resultado. El comentario de `draftIdsOn` (`:732-735`) dice «factura o
  boleta en `DRAFT`», pero no filtra `docType`. Igual que antes, pero el comentario promete algo
  que el código no hace.
- `cancel` llama dos veces a `cancelLockPlan` (seis lecturas). Si hay un presupuesto de consultas
  sobre `cancel`, revisarlo. Solo encontré presupuesto sobre `cancelPreview`.

## Caminos verificados sin hallazgo (pregunta 2 del encargo)

- **POS** (`pos.service.ts:221-300`). Orden: `createDirectInTx` (pedido y reservas nuevos, saldos
  en mano) → `dispatches.createInTx` (`salesOrders` propio, con `NOWAIT` porque llega con saldos en
  mano) → `invoicing.createInTx` (sin `dispatchId`, pedido ya tomado) → `assignInTx` y
  `addPaymentInTx` (comprobante nuevo propio, con `NOWAIT`). Todo lo que se pide fuera de orden son
  filas que la misma transacción insertó: el `NOWAIT` no puede fallar.
- **V9 confirm**: cotización → pedido nuevo → inventario → `createFromReservationInTx`
  (`salesOrders`/`reservations` propios, con `NOWAIT`). Sin riesgo.
- **addItems** (`sales-order-edits.service.ts:1015-1035`): pedido ya tomado y reservas de líneas
  nuevas (propias). Sin riesgo.
- **F5** (`redateInTx`): comprobante → todos los despachos por id → pedido (sin espera fuera de
  orden en la primera reversa) → inventario. El pedido de la segunda reversa ya está tomado. Las
  reservas, como en P3-1.
- **Nadie toma el pedido después de una OP sin `parent`**: las tres tomas de pedido detrás de una
  OP (`production.service.ts:689`, `roofing-production.service.ts:1310` y `:2273`) están precedidas
  por `lockOrder` con `own` o `parent` (`:607`, `:1006`, `:2125`). Son del corte 1 y no se tocaron.
- **C7, C8 y anular pedido**. Anular pedido (borradores → cotización → pedido → OP → reservas),
  reasignar (cotización → pedidos), borrador con despacho (despacho → pedido) y reversa (despacho →
  pedido → reservas → inventario) son coherentes entre sí. No encontré ningún camino que tenga el
  pedido y después escriba o tome por FK un borrador de comprobante.

## Tests adaptados

Revisé los 18 specs tocados. No se borró ningún `it`, y las aserciones crecen o se mantienen en
todos. Los cambios reemplazan aserciones sobre SQL crudo por aserciones sobre la tabla y los ids de
cada toma, más el orden contra la primera lectura que decide. En varios casos suben de valor:
`order-cancel-d383`, `reassign`, `move-to-order` y `fiscal-import-reactivate*`. El único que
perdió algo concreto es `dispatches-reverse-redate.spec.ts:113-125`: ya no exige que la reserva se
tome después de algo, pero lo cubre la lista ordenada `dispatches → sales_orders → reservations`.
Las brechas de cobertura están en P2-1.
