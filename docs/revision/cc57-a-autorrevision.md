# cc57-a — Autorrevisión

> **Autorrevisión — no vale como pase cruzado.** La hizo un subagente nuevo que no leyó el handoff
> ni las notas de implementación de la sesión. Es una lista de riesgos, no una aprobación.

Alcance: `git diff origin/main...HEAD` en la rama `cc57-a-reversas` (commit 244d96be), 25 archivos.
Solo lectura: no corrí tests, servidores ni bases. Lo que digo de los specs sale de leerlos, no de
correrlos.

## Llamadores revisados (grep)

| Función                        | Llamadores                                                                                                   | Efecto del cambio                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDirectInTx`             | `SalesOrdersService.createDirect`, `PosService` (pos.service.ts:254)                                         | `options.id` es opcional; el mostrador no lo pasa y sigue con su propio reclamo `pos-sale`. Sin cambio.                                                                    |
| `DispatchesService.createInTx` | `create`, `InvoiceDispatchService` (invoice-dispatch.service.ts:372, 397), `PosService` (pos.service.ts:280) | Sin `id` en esos llamadores; sin reclamo nuevo. Sin cambio.                                                                                                                |
| `QuotationsService.createInTx` | `create`, `QuotationImportService.confirm` (quotation-import.service.ts:903)                                 | El importador no pasa `id` ni clave. Sin cambio.                                                                                                                           |
| `planForLines`                 | invoicing.service.ts:1150 (registrar NC), :1441 (02), sales-returns.service.ts:315                           | Ahora una falla de `planReturnAllocation` cuesta una consulta extra (`aggregate`) y puede reescribir el mensaje.                                                           |
| `planReturnAllocation`         | solo `planForLines`                                                                                          | La parcial con prorrateo que se lo llevaba todo ahora se **rechaza** (antes pasaba y trababa la última).                                                                   |
| `fabricatedLooseLines`         | `cancel` (sales-orders.service.ts:2592, en tx) y `cancelPreview` (:2747, lector fuera de tx)                 | Una consulta más en los dos. Solo informa y pide el acuse; no escribe.                                                                                                     |
| `claimAttempt`                 | `deliver` (:2893), `deliverDispatchNote` (:3854)                                                             | Los dos llegan desde `send`, `retry`, `sendPending`, `issueDispatchNote` y `PosService` (pos.service.ts:364). El primer envío tiene `lastAttemptAt = null` y no se afecta. |
| `retry`                        | `InvoicingController` (:372)                                                                                 | 409 nuevo durante 90 s después de cualquier intento.                                                                                                                       |
| `annulExternal`                | `InvoicingController` (:527)                                                                                 | Toma además despachos devueltos y el pedido.                                                                                                                               |

`createQuotationSchema` también lo usan `updateQuotationSchema` (PUT de cotización) y
`createSalesOrderSchema`. El PUT ahora acepta `idempotencyKey` y la ignora. No encontré
`...input` ni `...body` volcados a Prisma en los servicios que tocó el corte, así que el campo
nuevo no llega a un `create`.

## Riesgos

### P0

Ninguno encontrado.

### P1

Ninguno confirmado. Lo más cerca de P1 es el R-1. Lo pongo en P2 porque falla de forma segura:
no duplica ni pierde datos.

### P2

**R-1. El reclamo del PSE no se suelta al terminar: bloquea el reintento legítimo 90 s después de
un fallo rápido.**
`apps/api/src/invoicing/invoicing.service.ts:298-308` (`sendClaimWhere`), `:2948-2962`
(`claimAttempt`) y `:3196-3205` (`retry`). `applyResult` no limpia `lastAttemptAt`. Así que el
«arriendo» no dura «mientras el envío está en vuelo»: dura 90 s desde que empezó, aunque
Nubefact haya contestado `SEND_ERROR` en 300 ms.

Escenario: una guía de remisión con el camión esperando (el comentario de `deliverDispatchNote`
lo menciona), o una venta de mostrador. El PSE contesta un error transitorio y el usuario
aprieta «Reintentar». Recibe el 409 «espera un minuto» durante un minuto y medio. Antes, el
reintento salía en el acto.

Hay además un falso silencio en `sendPending` (`:3247-3250`): `claimAttempt` descarta sin
avisar un documento cuyo reclamo sigue vigente, pero igual cuenta en `pending.length`, y el log
dice «N documentos reintentados» aunque no salió ninguno.

Sugerencia: aceptar el reintento manual cuando el estado ya es `SEND_ERROR` y `applyResult`
escribió después del reclamo. Otra forma: guardar en `applyResult` una marca que libere el
reclamo, por ejemplo poner `lastAttemptAt` en `now - LEASE`. Ojo: ese campo también se muestra
en el DTO (`:4504`) y en `fiscal-import.service.ts:1285`. Si no se cambia, que el dueño lo acepte
en el UAT.

**R-2. La exclusión depende de que Prisma resuelva `updateMany` en un solo `UPDATE … WHERE`.**
`invoicing.service.ts:2953`. La garantía nueva sale de que Postgres vuelva a evaluar el `WHERE`
(EvalPlanQual) sobre `last_attempt_at` cuando el segundo `UPDATE` se desbloquea. Si Prisma 6.19
emitiera `SELECT id … WHERE filtro` seguido de `UPDATE … WHERE id IN (…)` sin repetir el filtro,
las dos llamadas pasarían igual. Con filtros escalares creo que no lo hace, pero no lo verifiqué.

El spec `send-claim.db-spec.ts:161-163` sí cubre esto contra la base. Pero con dos `Promise.all`
sobre el pool, puede dar verde por pura serialización. Una corrida con el log de consultas de
Prisma (como en cc19) confirma la forma de la SQL en un minuto.

**R-3. D-14: la NC parcial que antes pasaba ahora puede rechazarse, también en el 01
(`upToAvailable`).**
`apps/api/src/invoicing/sales-return-allocation.ts:128-140`. Con
`min(prorrateo, leftReserve − 0.001)`, una línea de despacho cuyo `reserveQty` restante es
`0.001` rechaza **toda** devolución parcial: solo admite «el resto entero». Para unidades normales
(1 u = 1 en el kardex) no pasa. Pasa con líneas de poco kardex por unidad, o con dato heredado.

Caso heredado no cubierto: una línea a la que una parcial anterior ya le dejó
`returnedReserveQty == reserveQty` con unidades afuera (el defecto que se corrige). Ahí la
devolución entera da `reserveQty = 0` y sale «demasiado chica», sin salida. El mensaje nuevo no
lo dice. Conviene contar en producción cuántas `dispatch_items` quedan así, con una lectura por
servicio y no con SQL directo.

**R-4. D-06: «lo devuelto vuelve a contar como suelto» no comprueba que siga en el almacén.**
`apps/api/src/sales/order-cancel-checks.ts:293-326`. `back` suma el `reserveQty` de toda DEV-
vigente sobre despachos `ISSUED` de la línea. Si esa mercadería ya volvió a salir (otro pedido,
el mostrador o una producción), el diálogo de anular avisa de fabricado suelto que no existe y
exige el acuse. Solo es un aviso, no escribe. Pero cuesta una consulta más en `cancelPreview`
(la que se lee por cada apertura del diálogo) y no hay prueba contra la base: solo el unitario
con mocks (`order-cancel-d383.spec.ts`).

### P3

**R-5. D-02: un despacho que llega tarde ahora siempre sale con 409.**
`apps/api/src/invoicing/fiscal-import.service.ts:110-116`. Cuando la NC tiene devolución, el
pedido ya está tomado en el primer `lockDocuments`. Un despacho que se enlazó entre la lectura y
el bloqueo (`late`) es entonces de una clase anterior a otra ya tomada, y se pide con `NOWAIT`.
Si otra transacción lo tiene, el usuario recibe un 409 en vez de esperar. Es raro y es el
comportamiento documentado de D-475, pero cambia respecto de antes.

**R-6. D-02: lo que se bloquea sale de una lectura previa al bloqueo.**
`fiscal-import.service.ts:92-99`. `returnScope` se lee sin bloquear. Hoy es seguro porque la
devolución nace con la NC (`creditNoteId` único) y sus ítems no cambian. Lo que decide (el estado
del pedido, `:209-217`) se relee después del lock, así que cumple D-474. Si algún día una
devolución pudiera sumar ítems después, la lista de despachos quedaría corta.

**R-7. D-12: el mensaje se pega a cualquier `BadRequestException` del plan.**
`apps/api/src/invoicing/sales-returns.service.ts:214-216` y `:236-255`. También se pega a «una
bobina se devuelve entera» o a «demasiado chica». Y suma lo entregado sin kardex sin respetar
`asOf` ni `onlyAffected` (D-656), así que puede nombrar unidades de otro comprobante, o
posteriores a la NC, como causa. Además supone que `movementId = null` significa «antes del
inventario inicial»: si hay despachos sin movimiento por otra razón, el texto los atribuye mal.

**R-8. B-02: la repetición no comprueba que el recurso sea del mismo destino.**

- `coil-operations.service.ts:111-119`: el partido devuelve las hijas del `splitId` de la clave
  aunque el `coilId` de la URL sea otro. La merma devuelve la bobina de la URL sin mirar a qué
  bobina se aplicó la clave.
- En la web, la huella de `coil-split-dialog.tsx` y `coil-scrap-dialog.tsx` no incluye
  `coil.id`. Si el componente sobrevive al cambiar de bobina (navegación del cliente entre
  `/bobinas/[id]`) con una clave incierta, el reintento en la otra bobina devuelve el partido de
  la primera y no parte nada.

Sugerencia barata: meter `coil.id` en la huella y, en el servidor, comprobar
`split.parentCoilId === coilId`.

**R-9. B-02: la cotización usa el tiempo límite por defecto de la transacción.**
`quotations.service.ts:192-199`. `$transaction` sin `timeout` deja los 5 s por defecto. El
envío perdedor espera en el índice único de `idempotency_keys` a que el ganador confirme. Con una
cotización grande contra Neon, la espera puede pasar los 5 s y salir con 500. El cliente
reintenta con la misma clave y recibe la del primero, así que no duplica, pero el usuario ve un
error. El pedido directo y el despacho tienen 30 s.

**R-10. B-02: una cotización repetida no regenera el PDF.**
`quotations.service.ts:200`. Si el primer intento confirmó pero murió antes o durante
`generatePdf` (justo el caso del corte de red), `pdfKey` queda `null`. La descarga lo arma al
vuelo (`generatePdf`, comentario de `:1220`), así que no se pierde nada. Lo anoto solo para que
no sorprenda.

**R-11. B-04: el 409 sale antes de `assertOwnership`.**
`invoicing.service.ts:3196-3206`. Un vendedor ajeno recibe «hay un envío en curso» en vez del 403.
Filtra un dato menor (que hubo un intento hace menos de 90 s).

**R-12. `refreshStatus` («Consultar») sigue sin reclamo.**
`invoicing.service.ts:3371`. Puede cruzarse con un envío en vuelo: consulta mientras la emisión no
ha llegado. Esto ya pasaba antes del corte y queda fuera de B-04, pero es la misma familia.

## ¿Prueban los specs nuevos lo que dicen?

- **`idempotency-creates.db-spec.ts`**: sí, para lo que dice. En serie y a la vez, pedido directo
  y despacho dejan un solo efecto: cuenta líneas y `OUT … SALE`. Hay contraprueba sin clave en el
  despacho. Partido (en serie), merma (a la vez) y cotización (en serie) también.
  - Faltan: partido y cotización **a la vez** (solo en serie); merma en serie; contraprueba sin
    clave para partido, merma y cotización.
  - Falta el caso «primer intento con 4xx y después la misma clave»: la reversión suelta la clave.
    El diseño lo garantiza, pero nada lo fija.
  - Falta comprobar que una clave de otro scope no se repite.
  - En el pedido, `lines toBe(2)` cuenta las líneas del producto y no las reservas: no comprueba
    que la reserva se tomó una sola vez, que es el riesgo que nombra el comentario de `sales.ts`.
- **`send-claim.db-spec.ts`**: prueba el reclamo exclusivo y la expiración llamando al método
  privado. No prueba el 409 de `retry`, ni que `sendPending` se salte el documento, ni que el
  «Reintentar» del usuario siga funcionando después del plazo por el camino público. Sobre si el
  verde de la carrera es real, ver R-2.
- **Par nuevo de `lock-order.db-spec.ts` (`:1848-1937`)**: el invariante está bien dicho y
  `expectClean` exige que **cada** operación gane al menos una vez. Por eso no puede dar un verde
  vacío por una fixture que siempre rechaza: o falla o prueba las dos órdenes.
  - Riesgo de inestabilidad: si con `PAUSE_MS = 15` una de las dos gana las 20 iteraciones (la
    anulación del pedido tiene menos lecturas previas), el spec da rojo sin defecto. Vale mirar
    las `outcomes` que imprime en el log.
  - No cubre la NC con devolución sobre **varios** despachos, ni un despacho «tarde» (R-5).

Huecos sin ninguna prueba contra la base:

- D-06: lo devuelto cuenta en `cancel` y `cancelPreview`.
- D-12: el `aggregate` real sobre `movement_id IS NULL`.
- D-14: el registro de la NC parcial de punta a punta, incluido el 01 con `upToAvailable`.
- El 409 de `retry` (no hay unitario: ningún `*.spec.ts` llama `.retry(`).

## Resumen

No encontré P0 ni P1 confirmados. Lo más grave:

1. **R-1 (P2):** el reclamo del PSE no se suelta al terminar. Después de un fallo rápido,
   «Reintentar» da 409 durante 90 s (guía con el camión esperando, mostrador), y el barrido
   cuenta como reintentados documentos que se saltó.
2. **R-2 (P2):** la exclusión de B-04 descansa en que `updateMany` sea un solo `UPDATE` con el
   filtro. Hay que confirmarlo con el log de Prisma: el spec de carrera puede dar verde por
   serialización.
3. **R-3 (P2):** D-14 rechaza ahora algunas parciales que antes pasaban, también en el 01.
   El dato que ya quedó trabado (kardex agotado con unidades afuera) sigue sin salida.
4. **R-4 (P2):** D-06 cuenta como suelto lo devuelto aunque ya haya vuelto a salir, y no tiene
   prueba contra la base.

Los specs nuevos prueban lo que anuncian, con los huecos de la sección anterior. El par de
`lock-order` no puede dar un verde vacío, pero puede ser inestable.

---

## Respuesta del autor (cc57)

- **R-1:** igual que P2-1 del segundo modelo: se mantiene (sin migración), anotado en D-671; `sendPending` cuenta lo que intentó, no lo que salió (sin cambio).
- **R-2:** el spec reprodujo el doble reclamo sin el arreglo (`[true, true]`, `local-data/cc57/b04-antes.log`) y uno solo con él: el `UPDATE … WHERE` reevalúa el filtro tras la espera (READ COMMITTED).
- **R-3:** un dato ya trabado por una parcial anterior sigue sin salida; hoy no hay devoluciones en producción (audit-01). Anotado.
- **R-4:** se topó lo suelto por lo fabricado; que lo devuelto ya se haya vendido otra vez queda como límite del aviso (no escribe).
- **P3:** el 409 de `retry` va después del alcance; la huella de partido y merma incluye la bobina. El resto, anotado.
