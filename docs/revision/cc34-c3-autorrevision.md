# cc34-c3 — autorrevisión del commit `0cee9839`

> **Autorrevisión** (subagente nuevo, sin leer el handoff de implementación). Es una lista de
> riesgos, **no una aprobación** ni un pase cruzado. Fecha: 2026-10-08.

Alcance: `0cee9839` sobre `4f74343b`. «La baja queda en trámite (`VOID_PENDING`) antes de llamar
al PSE»: `voidDocument`, `createCreditNote`, `assertAffectedStillCreditable`, y los specs
`void-in-progress.spec.ts` y `credit-note-guards.spec.ts`. Leí también `refreshStatus`,
`sendPending`, `callProvider`, `NubefactProvider.post`, `receivables.service.ts`,
`pos.service.ts#voidSale`, `fiscal-import.service.ts` y la vista web del comprobante.

Corrida: `pnpm --filter @ayr/api exec jest src/invoicing` → 29 suites, **383 passed**, 0 failed.

---

## P0

Ninguno.

## P1

### P1-1. «Consultar al PSE» durante la llamada en curso deshace la marca y vuelve a abrir la ventana de D-536

- `apps/api/src/invoicing/invoicing.service.ts:2490-2537` (`refreshStatus`, rama `VOID_PENDING`),
  `apps/web/src/app/(app)/comprobantes/[id]/comprobante-detalle-view.tsx:547-551` y `:916`, y
  `apps/api/src/pos/pos.service.ts:496-500`.
- Escenario: el admin A da de baja F001-9; la marca se escribe y la llamada al PSE tarda hasta un
  minuto. En ese lapso cualquier usuario abre el comprobante: la pantalla ya lo muestra
  `VOID_PENDING`, con el aviso «La baja está comunicada…» y el botón «Consultar al PSE»
  (`canQuery`). Si lo aprieta (o un reintento de anulación de mostrador pasa por
  `pos.service.ts:498`), `refreshStatus` hace `consultar_anulacion` **sin bloquear la fila y sin
  mirar `voidRequestedAt`**:
  - si Nubefact responde con un error 4xx («no existe la anulación», porque la baja todavía no
    llegó), `NubefactProvider.post` lo traduce como `REJECTED` (`nubefact.provider.ts:240-256`) y
    `refreshStatus` deja la factura `ACCEPTED` con `voidRequestedAt: null` y un `rejectionCode`
    que SUNAT nunca dio. Después la llamada de A vuelve `ACCEPTED`/`PENDING`, el `updateMany` final
    (`:2784`, filtrado por `voidRequestedAt: requestedAt`) cuenta 0 y lanza «cambió de estado». La
    baja quedó en SUNAT, el ERP la tiene `ACCEPTED` y **ya se puede crear una NC**: es justo el
    caso de D-536 que el cambio quería cerrar.
  - si responde `ACCEPTED`, la factura pasa a `VOIDED` sin revisar cobros (ver P1-3) y A recibe un
    409 engañoso aunque la baja sí salió bien.
- Propuesta: en `refreshStatus`, rama `VOID_PENDING`, tomar `lockDocuments` y no consultar (409:
  «la baja se está comunicando ahora mismo») mientras la marca sea reciente y siga sin respuesta
  del PSE. Hoy no hay un campo que diga «marcada pero sin respuesta del PSE» (ver P1-2), así que
  esto necesita una decisión del dueño. Como mínimo, la rama `REJECTED` de `refreshStatus` debería
  bloquear la fila y verificar que el `count` sea 1 antes de auditar.

### P1-2. Si el proceso muere o `release` falla, `VOID_PENDING` puede quedar sin salida

- `invoicing.service.ts:2661-2702` (marca), `:2706-2727` (`release`) y `:2738-2746`.
- Antes de cc34, `VOID_PENDING` solo existía después de que el PSE acusara la baja (con ticket), y
  «Consultar al PSE» siempre encontraba algo. Ahora puede haber un `VOID_PENDING` **sin ninguna
  baja en el PSE**:
  1. Cloud Run recicla la instancia (deploy con cambio de tráfico, escala a cero, OOM) durante la
     llamada de hasta un minuto. Con despliegues «a cualquier hora» (D-533) no es raro.
  2. Falla la transacción de `release` (un P1001 pasajero de Neon, como ya se vio en cc26): la
     excepción de Prisma sube como 500 y la marca queda puesta. No hay `try/catch` ni reintento.
  3. Falla la transacción final después de un `ACCEPTED` o `PENDING` (cobro tardío, P1001): se
     pierden en el rollback el `providerTicket`, el `providerResponse` y la auditoría `void` (ver
     P2-2).
- Salida actual: «Consultar al PSE» → `queryVoidStatus`. En los casos 1 y 2 el PSE no tiene baja.
  Según cómo conteste Nubefact, la factura vuelve a `ACCEPTED` (con un `rejectionCode` y un
  `rejectionMessage` falsos: «SUNAT rechazó la comunicación de baja») o queda **`VOID_PENDING`
  para siempre** (si contesta 200 sin veredicto → `PENDING`, o 5xx → `ERROR`). En ese estado:
  no se puede volver a dar de baja (`:2633`, solo `ACCEPTED`), no se acredita (cc34), la venta de
  mostrador se corta con «sigue en trámite» (`pos.service.ts:500`) y sigue contando como deuda y
  como venta. No hay una puerta de administración para quitar la marca, y la regla 3 prohíbe el
  SQL directo. Esto no se puede verificar sin el PSE.
- Propuesta (decisión del dueño): (a) envolver `release` en `try/catch` con un reintento y dejar
  registro; (b) dar una salida determinista a una marca huérfana: por ejemplo, que `refreshStatus`
  trate como «no llegó» una consulta sin baja en el PSE cuando la marca no tiene acuse
  (distinguible por la auditoría `void-requested` sin un `void` o `void-released` posterior, sin
  migración), o una acción de admin «liberar baja sin acuse» que vuelva a consultar al PSE y quede
  auditada; (c) no escribir `rejectionCode`/`rejectionMessage` cuando el «rechazo» es que no
  existe la baja.

### P1-3. Un cobro que entra durante la llamada deja abierto el camino a «anulada con cobro vigente»

- `apps/api/src/invoicing/receivables.service.ts:133` (acepta cobros sobre `VOID_PENDING`, porque
  está en `LIVE_DOCUMENT_STATUSES`), `invoicing.service.ts:2758-2766` y `:2490-2510`.
- Escenario: marca → durante la llamada un vendedor registra un cobro sobre F001-9 (la marca no lo
  frena) → el PSE acepta → la transacción final ve el cobro, lanza «Revierte el cobro y usa
  "Consultar al PSE"» y la factura queda `VOID_PENDING`. Si alguien aprieta «Consultar» **antes**
  de revertir el cobro, la rama `ACCEPTED` de `refreshStatus` pasa la factura a `VOIDED` sin contar
  cobros: queda un comprobante anulado con dinero recibido, el guardarraíl M-2 que la propia
  función cita. El mensaje nuevo pide el orden correcto, pero nada lo hace cumplir. Antes de cc34
  la reconciliación de la rama `ACCEPTED` tenía el mismo hueco, así que el defecto no es nuevo; lo
  nuevo es que ahora el sistema **sabe** que la baja está en trámite y aun así deja cobrar.
- Propuesta: rechazar `addPayment` sobre `VOID_PENDING` con el mismo `VOID_IN_PROGRESS`. Va bajo el
  mismo bloqueo del comprobante (`receivables.service.ts:106`) y cierra la carrera por construcción
  (la marca se escribe con la fila tomada). Así el revalidado de cobros de `:2758` deja de ser
  alcanzable para las bajas nuevas. Es alcance nuevo: pide un `D-nnn`. Aparte, `refreshStatus`
  (`VOID_PENDING` → `VOIDED`) debería contar cobros vivos antes de anular.

## P2

### P2-1. Un `ERROR` por tiempo de espera libera la factura aunque la baja haya llegado

- `invoicing.service.ts:2738-2742`. `TIMEOUT`/`TRANSPORT` (`nubefact.provider.ts:204-219`) son
  justo el caso en que la baja pudo llegar a Nubefact. `release` vuelve la factura `ACCEPTED`, y
  desde ese momento se puede crear una NC sobre una factura que SUNAT quizá está anulando, el
  escenario de D-536. El mensaje sugiere «Consultar al PSE», pero nada lo exige.
- Propuesta (dueño): mantener la marca cuando el `code` es `TIMEOUT` o `TRANSPORT`, y liberar solo
  con un error que garantice que la baja no salió (`PROVIDER_UNAVAILABLE`, 4xx de contenido). Eso
  depende de que P1-2 tenga salida. Si se acepta el riesgo, dejarlo escrito en el `D-nnn`.

### P2-2. El rollback de la transacción final borra el rastro de la respuesta del PSE

- `invoicing.service.ts:2750-2826`. Si se lanza por cobro o nota viva, se pierden el ticket, el
  `providerResponse` y la auditoría `invoicing.document.void` con el `outcome`. `audit_log` queda
  con `void-requested` y nada más, aunque SUNAT ya aceptó o encoló la baja.
- Propuesta: guardar la respuesta (ticket, raw, outcome) en una transacción propia antes de
  revalidar, o escribir una auditoría `void-outcome-unapplied` fuera del rollback.

### P2-3. `release` sin efecto igual informa «El comprobante sigue vigente»

- `invoicing.service.ts:2706-2727` y `:2738-2742`. Si otro camino cambió el estado (P1-1, un
  `refreshStatus` que lo pasó a `VOIDED`), `release` cuenta 0, no hace nada, y al usuario se le
  dice «sigue vigente». Propuesta: que `release` devuelva el `count` y que el mensaje cambie cuando
  sea 0.

## P3

- **P3-1. Mensaje con el enum crudo en una segunda baja simultánea.** `:2633-2637`: el segundo
  intento lee `VOID_PENDING` fuera de la transacción y responde «Solo se da de baja un comprobante
  aceptado; este está VOID_PENDING». Propuesta: un caso propio con `VOID_IN_PROGRESS`.
- **P3-2. La auditoría final dice `before: ACCEPTED`.** `:2819-2826`: ahora el estado anterior real
  es `VOID_PENDING`.
- **P3-3. El aviso de la pantalla miente durante la llamada.** `comprobante-detalle-view.tsx:916`:
  «La baja está comunicada» se ve antes de que el PSE conteste. El encargo pedía mantenerlo, y para
  los casos viejos es correcto. Si se quiere afinar, «La baja está en trámite ante SUNAT» vale para
  los dos.
- **P3-4. `voidRequestedAt` como testigo de la llamada.** Verificado: la columna es `TIMESTAMPTZ(3)`
  (migración `20260904170000_fase5b…:87`) y un `Date` de JS tiene milisegundos, así que la igualdad
  es exacta de ida y vuelta. El riesgo que queda es teórico: dos instancias que calculen
  `requestedAt` en el mismo milisegundo y una liberación intercalada entre los dos `new Date()`. Un
  testigo único (UUID) sería más robusto, pero no hay columna libre sin migración. Se acepta.
- **P3-5. Los tests no prueban lo que más importa del cambio.**
  - El falso `updateMany` de `void-in-progress.spec.ts:53-65` solo compara `where.status`: ignora
    `voidRequestedAt`. Si se quita `voidRequestedAt: requestedAt` del filtro de `release` o del
    final, la suite sigue verde. El test «nunca se pisa otro estado» (`:129-135`) solo mira la
    forma del último `where`; no hay un escenario en el que otro camino haya cambiado el estado y
    `release` no lo pise.
  - No hay test de que la transacción de marca rechace con un cobro, una nota viva o un borrador
    que entró entre la lectura previa y el bloqueo.
  - No hay test del camino «cobro durante la llamada → queda `VOID_PENDING`».
  - «La baja en curso bloquea la NC» (`:146-180`) parte de un `VOID_PENDING` fijado en el mock, no
    de una NC pedida **durante** la llamada al PSE. Se puede probar llamando a `createCreditNote`
    desde dentro del mock de `voidDocument`.
  - Regla 17: las transacciones de marca y de `release` son caminos nuevos que toman documentos.
    Toman un solo comprobante y por `lockDocuments`, así que el orden es trivial, pero la regla pide
    sumar su par a `lock-order.db-spec.ts`. Falta, y no se agregó ningún `db-spec`.

## Verificado sin hallazgos

- **Orden de bloqueos (D-471).** La marca, `release` y la transacción final toman solo el
  comprobante y por `lockDocuments`. `createCreditNote` (`:960-962`), `register`/`send` y
  `addPayment` bloquean el mismo comprobante por la misma puerta. No hay `FOR UPDATE` nuevo ni
  inversión de orden.
- **NC creada justo antes de la marca.** Una NC viva cuenta en `:2675-2683`; un borrador lo detecta
  `draftCreditNoteBlock` (`:2684-2685`). Las dos se leen con la fila bloqueada. Una NC creada
  después de la marca la rechaza `createCreditNote` (`:998-1004`) con la fila bloqueada.
- **Dos bajas simultáneas.** La segunda se corta con el estado releído bajo bloqueo (`:2667-2669`),
  o antes con el chequeo previo. Nunca llegan dos llamadas al PSE.
- **`release` no pisa estados ajenos.** Filtra por `VOID_PENDING` y por el `voidRequestedAt` propio,
  restaura `voidRequestedAt` y `voidedById` originales (`include` trae todos los escalares), y solo
  audita si `count === 1`.
- **`PENDING` y `ACCEPTED`** salen de la marca propia. `PENDING` conserva `voidRequestedAt` de la
  marca, que es lo que necesita `refreshStatus`.
- **Lectores de `VOID_PENDING`.** Está en `LIVE_DOCUMENT_STATUSES`, así que durante la llamada los
  reportes (`sales-margin`, `sales-by-material`, `document-profitability`, `seller-dashboard`), la
  CxC, los despachos y la importación lo siguen tratando como vivo: no hay saltos de saldo mientras
  dura la llamada. `sendPending` usa `RETRYABLE` y no lo reenvía. El POS lo ve como «deshecho» y
  consulta (ver P1-1). `fiscal-import` solo mira `voidRequestedAt` en importados, que nunca pasan
  por esta baja.
- **`registerManual`.** El nuevo rechazo de `assertAffectedStillCreditable` es defensivo: un manual
  no llega a `VOID_PENDING` por esta ruta (`assertIssuedHere`).
- **Sin migración, sin `number` para dinero, sin SQL directo.** Los mensajes están en español y
  nombran el comprobante.
- **Unitarios.** `jest src/invoicing`: 383/383 en verde.

## Qué se hizo con cada hallazgo

| Hallazgo                             | Resolución                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 consulta durante la llamada     | Corregido: `refreshStatus` sobre un `VOID_PENDING` cuya última auditoría de baja es `void-requested` de hace menos de 5 min responde «La baja se está comunicando al PSE en este momento…» sin consultar. Test.                                                                                                                                                       |
| P1-2 `VOID_PENDING` sin salida       | Corregido sin migración: la auditoría de bajas dice si la marca tiene resultado (`void-requested` sin otra acción después = huérfana). Una huérfana de más de 5 min se puede **reintentar** con «Dar de baja» (marca nueva; si falla, vuelve a aceptada). Si `release` falla por la base, la marca queda huérfana y sale por el mismo camino. Tests.                  |
| P1-3 cobro durante la llamada        | Sin cambio de regla: rechazar cobros sobre `VOID_PENDING` es una regla de negocio que el brief no decidió. El cobro que entra durante la llamada deja la baja en trámite **con su ticket y su respuesta** y pide revertir el cobro y consultar al PSE (igual que antes de cc34, cuando quedaba aceptada y la consulta la reconciliaba). Queda para el dueño en D-542. |
| P2 ERROR por timeout libera          | Sin cambio: es la decisión del dueño («si la llamada falla, la marca se quita») y el comportamiento de antes; el mensaje sigue avisando que la baja pudo llegar. Riesgo aceptado en D-542.                                                                                                                                                                            |
| P2 rollback borra ticket y auditoría | Corregido: el conflicto de la transacción final escribe ticket, respuesta y `void-conflict` antes de responder 409. Test.                                                                                                                                                                                                                                             |
| P2 «sigue vigente» sin liberar       | Corregido: si la marca ya no es la de esta llamada, responde «cambió de estado…: usa «Consultar al PSE»». Test.                                                                                                                                                                                                                                                       |
| P3 enum crudo                        | Corregido: «La baja ya está en trámite ante SUNAT: usa «Consultar al PSE»» o el mensaje de baja en curso.                                                                                                                                                                                                                                                             |
| P3 auditoría `before`                | Corregido: la final dice `VOID_PENDING`.                                                                                                                                                                                                                                                                                                                              |
| P3 aviso del web                     | Sin cambio (pieza de API).                                                                                                                                                                                                                                                                                                                                            |
| P3 tests                             | Corregido: el `updateMany` falso respeta `voidRequestedAt`; casos de cobro durante la llamada, liberación con count 0, segunda baja y huérfana. El par de `lock-order.db-spec.ts` no aplica: la baja toma un solo comprobante con `lockDocuments`, sin segunda clase ni segundo documento que ordenar.                                                                |
