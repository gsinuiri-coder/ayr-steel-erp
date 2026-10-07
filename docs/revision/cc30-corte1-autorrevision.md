# cc30 corte 1 — Autorrevisión (no es un pase cruzado)

> **Autorrevisión (no es un pase cruzado).** La hizo un subagente nuevo, sin el handoff de
> implementación. Es una lista de riesgos y no aprueba nada. Faltan el pase del segundo modelo y la
> revisión del dueño.

**Alcance:** `git diff origin/main...HEAD -- apps` en la rama `cc30-bloqueos-documentos`
(commits `d5be6b2f`, `ec93fb65`, `fdd4d22d`). Para el contexto leí
`docs/analisis/cc30-matriz-bloqueos.md` (§6, cruces C1–C6 y C12) y las filas D-470..D-476 de
`docs/ARQUITECTURA.md`. No corrí tests ni modifiqué código.

**Resumen:** no encontré P0 ni P1. No vi ningún cambio de resultado de negocio, de mensaje al
usuario ni de estado escrito: los `throw` y las escrituras son los mismos, y solo se movieron las
tomas de bloqueo. Tampoco encontré un ciclo nuevo en el camino normal. Revisé todos los llamadores
de `lockOrder`: `production.service.ts` (consume, release, report, reverseReport, closeInTx, reopen
y cancel), `roofing-production.service.ts` (updatePlan, mountCoil, releaseCoil, reportInTx,
setPriority, closeInTx, reverseReport, reopen y cancel), `roofing-drafts.service.ts` (remove y
loadState) y `close-preview.ts`. En las transacciones que llaman a `lockOrder` más de una vez
(`reportAndClose`, `previewReportAndClose`, el commit de borradores con N filas y el preview de
cierre), la segunda llamada pide los mismos ids de pedido y de OP. La puerta los encuentra en el
estado y no emite SQL. Por eso no aparece `NOWAIT` aunque ya haya bobinas o saldos en mano. La
reserva de producto que crea el primer reporte de un commit de borradores la pide el segundo
reporte con `NOWAIT`, porque ya hay inventario en mano. Esa fila es de la propia transacción, así
que la toma sale bien. Hay tres P2.

---

## P2

### P2-1 — Todas las operaciones de planta toman ahora el pedido `FOR UPDATE`, también las livianas

- **Dónde:** `apps/api/src/production/production-shared.ts:57-98` (`lockOrder`). Afecta a todos sus
  llamadores, también a los que no escriben ni pedido ni reserva: `setPriority`
  (`roofing-production.service.ts:1836`), `updatePlan` (`:481`), `remove` de borradores
  (`roofing-drafts.service.ts:185`), el guardado de borradores (`:105`, `:153` vía `loadState`
  `:359`), `mountCoil`/`releaseCoil` y `consume`/`release` de drywall.
- **Escenario:** un despacho, la emisión de un comprobante, `updateItemQty` o una anulación de
  pedido tienen el pedido S tomado durante varios segundos. Mientras tanto, planta cambia la
  prioridad de la OP o borra una fila del borrador. Antes, esa operación solo esperaba por la OP.
  Ahora espera por S. `setPriority`, `updatePlan` y `remove` corren con el `timeout` por defecto de
  Prisma (5 s). Si la espera pasa de ese límite, sale un P2028 (timeout de transacción interactiva),
  que no es el 409 de `LockConflictFilter`. En sentido inverso, un `mountCoil` que espera bobinas
  del agregado retiene ahora S, y las operaciones comerciales sobre ese pedido quedan detrás de
  planta. No hay ciclo, pero sí más contención entre ventas y planta, y eso lo nota el usuario. Ni
  el principio «cambia cuándo, no qué» ni D-470 lo mencionan.
- **Propuesta:** tomar solo la OP en las operaciones que no escriben ni el pedido ni la reserva
  (prioridad, plan, borradores). Un subconjunto del orden canónico sigue siendo orden canónico, así
  que no abre ningún cruce. Por ejemplo, con `lockOrder(tx, id, { parent: false })` o una variante
  `lockOrderOnly`. Si se mantiene así, hay que medir la espera real y anotarlo como riesgo aceptado
  en la fila D-470.

### P2-2 — El centinela de la puerta de documentos no existe, y la puerta no es la única

- **Dónde:** `apps/api/src/inventory/document-locks.ts:11-14` («el único `FOR UPDATE` sobre las
  tablas de documentos … Lo vigila `document-locks.sentinel.spec.ts`») y D-473, que describe ese
  centinela. El archivo no está en la rama (`ls apps/api/src/inventory/`).
- **Escenario:** siguen existiendo `FOR UPDATE` crudos sobre `sales_orders` y `reservations` fuera
  de la puerta:
  - `sales_orders`: `dispatches.service.ts:193`, `:729`; `invoicing.service.ts:503`;
    `invoice-dispatch.service.ts:319`; `fiscal-import.service.ts:322`, `:631`;
    `sales-orders.service.ts` (`lockOrder` en `:4211`).
  - `reservations`: `sales-orders.service.ts:2375`, `:2706`, `:2885`;
    `sales-order-edits.service.ts:403`; `production.service.ts:289`;
    `roofing-production.service.ts:268`.

  Esas tomas no quedan en el estado por transacción, así que la detección «fuera de orden →
  `NOWAIT`» de `lockDocuments` solo ve una parte. Si en una transacción se mezclan una toma cruda
  y la puerta, el ciclo no se detecta. Además, cualquier `FOR UPDATE` nuevo sobre esas tablas pasa
  sin que nada falle.

- **Propuesta:** si el centinela y la migración del resto de llamadores son del corte 2, hay que
  decirlo en el comentario y en D-473: «vigente desde el corte 2», con el pendiente anotado en
  `PROGRESO.md`. Si no, crear el centinela ahora con una lista blanca explícita de las tomas crudas
  que quedan.

### P2-3 — La protección real del grupo C es el pedido como mutex grueso; D-472 no queda aplicada en planta

- **Dónde:**
  - Varias operaciones siguen escribiendo la reserva con implícito después del inventario, sin la
    puerta: `production.service.ts:1549` (cancel de drywall, `restoreReservationIfIdle`) y `:984`
    (reverseReport de drywall; ahí sí se toma la reserva antes, con `own`), cancel y reopen de
    coberturas, y `mountCoil`/`releaseCoil`. El comentario de
    `sales-orders.service.ts:2442` dice que «montar … bloquea la OP y después la reserva».
  - Las altas de OP desde una reserva toman la reserva sin pasar por el pedido:
    `production.service.ts:289` y `roofing-production.service.ts:268`, más `createFromSalesOrder`
    (C6).
- **Escenario:** hoy no se forma ciclo, porque todo camino que escribe reservas y espera por
  inventario toma antes el pedido (anular, completar reserva, despachar, `updateItemQty` y ahora
  planta). Eso serializa por S. Pero queda frágil: un camino nuevo que toque la reserva y el
  inventario sin el pedido (como C6) vuelve a abrir el cruce, y la puerta no lo detecta porque esas
  escrituras implícitas no quedan en el estado.
- **Propuesta:** anotarlo en `PROGRESO.md` como pendiente del corte 2 (C6 más «reserva antes del
  inventario» en cancel y reopen de ambas líneas y en mount/release), o pasar `{ own: true }` en
  esos `lockOrder`. Cuesta una toma más y deja D-472 cumplida sin depender del mutex.

---

## P3

### P3-1 — Parámetro `extra` de `lockOrder` sin uso

`production-shared.ts:62-65,88`. Ningún llamador lo pasa (`grep "extra:"`). El reporte de coberturas
toma la reserva del producto con una segunda llamada a `lockDocuments`
(`roofing-production.service.ts:1016`), en vez de usar `extra`. **Propuesta:** quitarlo, o usarlo
en `reportInTx` y en `reverseReport` para que la toma de reservas vaya en la misma pasada que
pedido y OP.

### P3-2 — `updateItemQty`: lo que se crea entre la lectura de ids y la toma no queda bloqueado

`sales-order-edits.service.ts:661-668`. Antes, `WHERE "sales_order_item_id" = … FOR UPDATE` se
evaluaba en el momento de la sentencia y bloqueaba también una reserva recién confirmada. Ahora los
ids se leen sin bloqueo y después se bloquean. Escenario: `createFromReservation` de drywall
(`production.service.ts:289`), que no toma el pedido, crea una OP sobre R entre la lectura y la
toma. `updateItemQty` espera por R, relee y ve la OP nueva. Esa OP no queda en el conjunto
bloqueado y se escribe en `:837` con implícito, después del inventario. No hay ciclo, porque la
planta sobre esa OP toma antes el pedido, que ya está tomado. **Propuesta:** después de la
relectura de `:669`, pasar por `lockDocuments` las OP que no estaban en `linked`. Con inventario
todavía sin tomar, eso va en orden.

### P3-3 — Reserva cambiada entre la lectura y la toma en `lockOrder`: el `NOWAIT` puede dar 409

`production-shared.ts:94-96`. Si `updateItemQty` mueve la OP de R_viejo a R_nuevo mientras un
reporte de drywall (`own`) espera el pedido, el reporte toma R_viejo y después R_nuevo. Si
`id(R_nuevo) < id(R_viejo)`, lo pide con `NOWAIT`. Solo falla si una tercera operación tiene
R_nuevo sin el pedido (las altas de P2-3), y en ese caso sale un 409 legítimo. Además, R_viejo
queda bloqueado sin necesidad hasta el commit. **Propuesta:** dejarlo así y documentarlo como
carrera aceptada.

### P3-4 — Mensaje de log con concordancia de género

`row-locks.ts:102-103`. `NOWAIT: ${what} tomada por otra operación` deja «pedido tomada». Solo va
al log (`lock-conflict.filter.ts:64`), no al usuario. **Propuesta:** «${what}: ocupada/o…», o pasar
el participio junto con la etiqueta en `LABELS`.

### P3-5 — Comentarios y documentación desactualizados

- `production-shared.ts:53-56`: el JSDoc de `lockOrder` sigue diciendo «`SELECT … FOR UPDATE` sobre
  la orden y después su lectura».
- `sales-orders.service.ts:2442-2446`: «montar una bobina bloquea la OP y después la reserva …
  tomarlas acá en el orden inverso abriría un deadlock». Con D-470, montar toma antes el pedido.
- `docs/ARQUITECTURA.md:573` (§3.3.1): sigue diciendo «la OP antes que el pedido», aunque D-470
  dice que lo reemplaza.

### P3-6 — Tests: espía sin restaurar y pausas en tomas vacías

`lock-order.db-spec.ts:1058-1066`. `jest.spyOn(documentLocks, 'lockDocuments')` se instala en un
`beforeAll` y no se restaura (no hay `afterAll`). Hoy afecta, a propósito, al `describe` de
drywall que viene después. Si se agrega un `describe` más abajo, ese también hereda la pausa. La
pausa se aplica también a las llamadas que no emiten SQL (todo ya en mano), y eso alarga las
transacciones de `reportAndClose` y del commit de borradores más que la toma real. **Propuesta:**
`afterAll(() => jest.restoreAllMocks())` en el `describe` de drywall, o un espía por `describe`, y
pausar solo cuando hubo SQL.

### P3-7 — Tests: qué prueban y qué no

- En (a)×anular, (b) y (d)×anular, la anulación se rechaza siempre (`alwaysRejected: [1]`). El par
  solo mide que no haya 40P01 ni 409. Es correcto según la matriz (la anulación toma pedido y
  reservas antes de rechazar), pero no queda evidencia de que el par fallaba antes del arreglo.
  **Propuesta:** registrar la mutación como en cc18 (sin el `own`/pedido en `lockOrder`, o con el
  `lockOrder` viejo, el par da 40P01) y anotarla en el handoff.
- Pares de la matriz sin test: C4 pareja 2 (`mountCoil`/`releaseCoil` × `updateItemQty`), C4
  pareja 3 (drywall), C2 con coberturas y C12 (anular OP × anular pedido). Cuentan como cerrados
  por el pedido, pero no están medidos.
- `lock-order-parent.spec.ts` espía `lockDocuments` como export del módulo. Funciona porque ts-jest
  compila a CJS y el import se resuelve como `document_locks_1.lockDocuments`. Con ESM o
  `isolatedModules` y otro transform, el espía dejaría de interceptar, y el test fallaría (el fake
  no tiene `$queryRaw`), no pasaría en falso. Sin acción; queda anotado.
- `document-locks.spec.ts`: en el primer caso, el fake devuelve como «bloqueados» los ids que
  recibe, y ya vienen en minúsculas por `sortedUniqueIds`. La aserción `out.salesOrders = [C]`
  prueba la normalización, no que Postgres devuelva minúsculas. Es correcto para `uuid`.

---

## Verificado sin hallazgo

- **(1) Resultado de negocio y mensajes:** sin cambios. El `NotFoundException('Orden de producción
no encontrada')` se conserva (el P2025 de `findUniqueOrThrow` en Prisma 6.19.3 trae
  `code: 'P2025'`) y no aborta la transacción. Los ids malformados ya los frena `ParseUUIDPipe`
  en los controladores.
- **(2) Ciclos nuevos:** ninguno en el camino normal. Todo camino que escribe OP fuera de
  producción (`sales-orders.service.ts:2447`, `sales-order-edits.service.ts:837`) lo hace con el
  pedido tomado antes. Ningún servicio de ventas o facturación llama a `lockOrder` de producción
  con inventario o reservas en mano. El `salesOrderId` de una reserva no cambia nunca (no hay
  `reservation.update` con `salesOrderId`).
- **(3) Filas que dejan de bloquearse:** `lockDocuments` filtra solo los `null`/`undefined` y pasa a
  minúsculas igual que Postgres. Las tomas que se reemplazaron (`sales_orders` en
  `production.service.ts:683`, `roofing-production.service.ts:1304`/`:2256`; reserva del producto
  en `:2521`) quedan cubiertas por la toma previa de `lockOrder`, o se piden con `NOWAIT` si el id
  no coincide. La única diferencia de alcance es P3-2.
- **(4) Estado que decide leído antes del bloqueo:** `lockOrder` relee la OP con `readLockedOrder`
  después de tomarla. En `reportInTx` y `reverseReport`, `onProduct` se lee antes, pero solo se usa
  su id para bloquear (en `reverseReport` era así desde antes). `updateItemQty` relee reservas y OP
  después de la toma.
