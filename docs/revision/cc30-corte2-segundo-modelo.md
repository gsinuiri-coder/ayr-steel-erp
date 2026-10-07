# cc30 corte 2 — revisión de segundo modelo

Rama `cc30-corte2`, diff `origin/cc30-bloqueos-documentos...HEAD` (36 archivos, 6 commits). Revisor:
segundo modelo (Sonnet), contexto limpio, **sin modificar código**. No es la revisión del dueño ni
firma la entrega.

Corrido: unitarios de `src/sales`, `src/invoicing`, `src/inventory/*.sentinel`,
`production/lock-order-parent`, `purchases/purchase-received-date-fix`,
`imports/quotation-import-coil` — 81 suites, 1111 tests, todas verdes. No se corrió `jest.db.config`
(la base está en uso); los hallazgos de concurrencia salen de leer el código y de la matriz, no de
una reproducción.

## Resumen

| Severidad | Cantidad |
| --------- | -------- |
| P0        | 0        |
| P1        | 0        |
| P2        | 4        |
| P3        | 6        |

El corte es correcto en lo que cambia: los `FOR UPDATE` sobre documentos pasan todos por la puerta,
el estado que decide se lee después del bloqueo, y no encontré un deadlock nuevo, ni un `NOWAIT` en
un camino normal sin contienda, ni una fila que deje de bloquearse. Los P2 son huecos (violaciones
de la matriz sin tocar, una ventana nueva por el cambio a `NO KEY UPDATE`, cobertura de pruebas), no
regresiones.

## Lo que verifiqué y está bien

- **`NOWAIT` solo con contienda real.** `NOWAIT` falla únicamente si otra transacción tiene la fila.
  Los casos donde el orden llega «fuera de orden» sobre filas propias (POS: `invoicing.createInTx`
  pide `dispatches` con el pedido ya tomado; `assignInTx` sobre el borrador recién insertado) piden
  `NOWAIT` sobre filas que nadie más ve: nunca fallan. Re-fechado con varios despachos
  (`redateInTx` → `reverseInTx` ×N): los despachos y el pedido ya están tomados; las reservas del
  segundo van con `NOWAIT` (hay saldos y bobinas en mano), pero solo fallan si otra operación tiene
  esa reserva, y toda operación que la escribe toma antes el pedido, que ya es nuestro.
- **Confirmar cotización y agregar ítems** (`lockQuotationHead`, `lockOwnQuotation`): la cotización
  es lo primero de la transacción; sin nada tomado, la toma es bloqueante.
- **C7**: `reassign` toma cotización → pedidos (por id), y `cancel` toma ahora cotización → pedido.
  Sin cruce. `confirm` ya tomaba la cotización primero.
- **C8**: `createInTx` toma `[despacho, pedido]` en una sola sentencia por clase y la reversa lee el
  pedido del despacho (inmutable) y toma los dos en el mismo orden. `discardDraft` toma el
  comprobante antes de leer `DRAFT` (cierra F8).
- **Anular pedido**: lee ids sin bloqueo, toma comprobantes (borradores) → cotización → pedido → OP →
  reservas, y relee el conjunto con el pedido tomado. Anular no escribe despachos, así que el par
  despacho → pedido no se cruza.
- **Reactivar / traer comprobante**: comprobante + borradores en una sentencia y después los
  pedidos; el pedido actual del comprobante se vuelve a pedir tras leerlo (cubre el cambio por
  «traer a otro pedido»). La relectura de borradores solo emite sentencia si nació uno nuevo.
- **Tipos al pasar de SQL crudo a Prisma**: `valid_until`/`issue_date` (`Date`), `promisedDeliveryDate`,
  `totalPen.toString()` (misma clase `Decimal`), `sellerId` (`string | null`, igual que el raw) —
  sin diferencias observables. La lectura posterior al `FOR UPDATE` en una sentencia aparte ve el
  estado confirmado (READ COMMITTED), así que equivale a la fila devuelta por el raw.
- **C11**: los advisory locks por clave se toman ordenados y fuera de los savepoints (un
  `ROLLBACK TO` soltaría los tomados adentro); el lock del bucle es reentrante.
- **C10**: `lockPurchases` antes que el inventario, por id y con `NO KEY UPDATE` (el modo del
  `UPDATE` de la fecha). Sin cambio de resultado.
- **Centinela**: barre las mismas carpetas que el de bobinas, excluye specs, cubre las 7 tablas y
  comprueba que la puerta sigue bloqueándolas. No hay otro `FOR UPDATE` sobre esas tablas en el repo
  (grep propio de `FOR (NO KEY )?UPDATE|FOR SHARE|pg_advisory` en `apps`, `scripts`, `packages`).

## P2

### P2-1. F4 y F9 siguen sin bloquear lo que deciden (violación #12 de la matriz)

`apps/api/src/invoicing/invoice-dispatch.service.ts:308-319` (`executeInTx`) lee el comprobante sin
bloqueo (`exists`) y toma solo el pedido; el comprobante se planifica (`buildPlan`) y se enlaza
(`UPDATE dispatches SET invoice_id`, que toma KEY SHARE sobre el comprobante) sin haberlo
bloqueado. `invoicing.service.ts` `registerManual` (~:1186, matriz F9 :1220) lee el pedido sin
bloqueo. D-474 pide que lo que decide se relea tras el bloqueo y D-471 pone el comprobante primero.

Escenario: despachar a la fecha del comprobante (F4) mientras se anula el comprobante o se le
registra un cobro: F4 planifica sobre un estado que puede haber cambiado, y su enlace espera el
`FOR UPDATE` del otro. Con el re-fechado (F5: comprobante → despachos → pedido) sobre el mismo
comprobante, F4 (pedido → KEY SHARE del comprobante) cierra un ciclo.

Propuesta: en `executeInTx`, `lockDocuments(tx, { fiscalDocuments: [invoiceId], salesOrders: [...] })`
(es no-op cuando viene de `redateInTx`, que ya lo tiene) y que `buildPlan` lea después; en
`registerManual`, tomar el pedido por la puerta tras el comprobante. Si se difieren al corte 3, que
conste en PROGRESO.

### P2-2. C9: `NO KEY UPDATE` abre una ventana que antes cerraba `FOR UPDATE`

`apps/api/src/purchases/purchase-received-edit.service.ts:122-135`. Con `FOR UPDATE`, partir o
recibir corte (que inserta hijas con `purchase_id` heredado, KEY SHARE) esperaba a la edición. Ahora
pasa en paralelo, y `coilIds` se lee **antes** de bloquear las bobinas: una hija que nace mientras la
edición espera a la madre no entra en el conjunto bloqueado, y `applyItems` la escribe después de los
saldos (`bobinas I`, orden inverso de D-386) sin haberla tomado por la puerta.

Escenario: editar compra recibida × partir una de sus bobinas, con la edición tomando la madre
después de que el partir hace commit. Estrecho, y no es un deadlock seguro, pero el cambio de modo
mueve una garantía y la matriz marca C9 como «deducido, no reproducido».

Propuesta: tras `lockRawMaterialCoils`, releer los ids de bobinas de la compra y, si hay nuevos,
pedirlos por `lockCoilRows` (van con `NOWAIT` y salen como 409, como el resto de la puerta); y
agregar el par C9 a `lock-order.db-spec.ts` (ver P2-4).

### P2-3. Re-fechado con varios despachos: sin prueba contra la base de las tomas fuera de orden

`apps/api/src/invoicing/dispatches.service.ts:870-878` (`lockForReverse`): para el segundo despacho
las reservas se piden con `NOWAIT` (hay bobinas y saldos del primero en mano). El spec unitario
(`dispatches-reverse-redate.spec.ts`) solo comprueba el orden de sentencias con un mock de un
despacho. No hay par en `lock-order.db-spec.ts` de re-fechado con ≥2 despachos × otra operación sobre
las mismas reservas. El análisis de arriba dice que no debería haber contienda (todo pasa por el
pedido), pero es exactamente el camino que el brief pide vigilar y queda sin prueba.

Propuesta: un par «re-fechar comprobante con 2 despachos × liberar/restaurar reserva de uno de ellos»
y que `expectClean` exija 0 conflictos.

### P2-4. Solo C7 y C8 tienen par contra la base; C6, C9, C10 y C11 no

La matriz define un test para cada cruce (`cc30-matriz-bloqueos.md` §C6–C11) y el corte corrige los
seis, pero `lock-order.db-spec.ts` suma solo C7 y C8. C6 (`roofing-production.service.ts:1892`),
C9, C10 (`purchase-received-date-fix.ts`) y C11 (`quotation-import.service.ts:858`) quedan cubiertos
por lectura. Si un cambio posterior los revierte, ningún test lo ve (el centinela solo vigila
`FOR UPDATE` sobre documentos, no el orden).

Propuesta: al menos C6 (OP del pedido × anular) y C11 (dos confirmaciones con documentos en orden
inverso) en este corte; C9/C10 si la fixture lo permite, o dejar constancia en PROGRESO.

## P3

- **P3-1. Pruebas C7/C8 sin pausa propia.** `lock-order.db-spec.ts:1413-1499`: heredan la pausa tras
  cada `lockDocuments` instalada en el `beforeAll` del bloque anterior (`:1062-1069`), pero el bloque
  nuevo no la declara. Si alguien lo mueve o corre solo (`-t`), el spy no existe y los pares dejan de
  ser deterministas. Instalar la pausa (o factorizarla a un helper) dentro del bloque nuevo. Además,
  `race` invierte el arreglo de operaciones y `okByOp` cuenta por posición, no por operación (patrón
  heredado): en iteraciones impares el «ok» de la posición 0 es de la otra operación.
- **P3-2. `releaseReservation` no relee las OP tras bloquear** (`sales-orders.service.ts` ~:2660-2682).
  Las OP vivas se leen sin bloqueo antes de tomar el pedido; una OP que nace en el medio no queda
  bloqueada (la que anular el pedido sí cubre con `relock`). La decisión «está fabricando» se lee
  después, así que el resultado es correcto; solo es asimétrico con `cancel`.
- **P3-3. `createFromSalesOrder` ahora bloquea el pedido** durante toda la transacción (hasta 60 s,
  `roofing-production.service.ts:1892-1901`), cuando antes no lo tomaba. Es lo que pide C6/D-472 y no
  cambia resultados, pero una edición del pedido en ese lapso espera; vale una línea en el UAT.
- **P3-4. Reactivar toma el pedido aunque ninguna línea lo use** (`fiscal-import.service.ts` ~:970, el
  spec lo documenta: 2 sentencias en vez de 1). Sin riesgo de deadlock; solo una espera más.
- **P3-5. Límites del centinela.** `document-locks.sentinel.spec.ts:28-31`: no reconoce nombres con
  esquema (`"public"."sales_orders"`) ni un `FROM` a más de 600 caracteres del `FOR UPDATE`, y un
  backtick dentro del bloque corta la ventana. Aceptable (el cuerpo del código no usa esas formas),
  pero conviene decirlo en el docblock junto con lo que no ve (`UPDATE` implícitos, que ya dice).
- **P3-6. `quotation-purge.ts`** ordena por id en vez de `seq` y lee los ids sin bloqueo antes de
  tomarlos: si una cotización con ese `seq` se crea entre la lectura y la toma, no queda tomada.
  `planQuotationPurge` relee después y la purga solo actúa sobre anuladas, así que no hay efecto
  práctico; mencionarlo por D-474.

## Coherencia con las decisiones

- D-470/D-471 (orden comprobante → despacho → cotización → pedido → OP → reserva): el código y los
  comentarios de `document-locks.ts` coinciden con la tabla de D-471 y con §3.3.1 de ARQUITECTURA.
- D-473 (puerta única + `NOWAIT` fuera de orden + centinela): cumplido para las 7 tablas.
- D-474 (estado leído después del bloqueo): cumplido en el diff salvo P2-1 (F4/F9) y el matiz P3-2/P3-6.
- D-475 (reestructurar en vez de `NOWAIT`): cumplido; el `NOWAIT` queda como red en la relectura de
  anular y de reactivar.
- Reglas 8 y 17 de AGENTS.md: sin escritores nuevos de kardex ni `FOR UPDATE` sobre `coils` o
  saldos fuera de sus puertas; sin migraciones.
