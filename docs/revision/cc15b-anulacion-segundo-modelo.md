# Revisión de segundo modelo (Sonnet, contexto limpio) — cc15b, P2-2: anulación con entradas ajenas posteriores

Fecha: 2026-10-03
Commit revisado: `1c4efd4` (padre `32a1989`). Solo lectura; corrí `purchase-cancel.spec.ts` (8 verdes). No pude correr el `db-spec` ni el E2E (requieren base de pruebas / servidor).

Archivos del diff: `purchase-cancel.ts` (nuevo `laterMovementsWhere`, `findBlockingLaterMovements`), `purchases.service.ts` (`assertNothingMovedAfter` delega), `purchase-cancel.spec.ts`, `purchase-cancel.db-spec.ts`, `e2e/tests/editar-compra-recibida-cc15b.spec.ts`.

Veredicto: no encontré P0 ni P1. Un P2 real (carrera que el cambio vuelve más dañina) y tres P3.

---

## P0

Ninguno.

## P1

Ninguno.

## P2

### P2-A. El chequeo de «posteriores» corre sin el lock del saldo; con la regla nueva, una venta concurrente ya no la frena la comprobación del saldo final

- Dónde: `apps/api/src/purchases/purchases.service.ts:763` (`assertNothingMovedAfter`) frente a `apps/api/src/inventory/inventory.service.ts:459-` (`reverse` toma `lockBalance` después). Contraste: `replaceEntry` comprueba su precondición **bajo** el lock (`inventory.service.ts` ~638-660, «comprobada acá adentro y bajo el lock del saldo»).
- Escenario: producto P con la compra A (10 u a 20, 200) y la compra B posterior (4 u a 80, 320); saldo 14 u, valor 520. Alguien anula A. `cancel` lee `own`, ejecuta `assertNothingMovedAfter` (sin salidas: pasa; B ya no cuenta) y recién después, en `reverse`, toma el lock. Entre medio, una venta de 3 u se confirma (la venta toma el lock del saldo, no la fila de la compra): saldo 11, valor 408,57 (salida al promedio mezclado). Luego `reverse` de A: `stockAfterReverseIn` solo comprueba `origQty <= qty` (10 <= 11) y que el valor no quede negativo; pasa. Resultado: 1 u con valor 208,57, es decir costo promedio de 208,57 por unidad cuando el correcto ronda 80. El kardex valoriza mal esa unidad y todo lo que la lea (margen, precio sugerido D-032).
  - Antes del cambio la misma carrera existía, pero la comprobación de cantidad (`origQty > qty`) la frenaba casi siempre porque no había entradas ajenas que «cubrieran» el hueco. Ahora que B suma stock, la venta concurrente cabe en el saldo y la anulación pasa sin ver la salida. El cambio ensancha el daño de una ventana que ya estaba; la ventana dura toda la transacción (hasta 120 s en compras de 200 líneas, `cancel`: `timeout: 120_000`).
  - Probabilidad baja (venta del mismo SKU en esos segundos), impacto de dato corrupto de costo; por eso P2 y no P3.
- Arreglo sugerido: en `cancel`, antes de `assertNothingMovedAfter`, tomar el lock de saldo de cada ítem PRODUCT vivo de la compra (mismo `lockBalance`, expuesto como método interno de `InventoryService` o un `lockBalancesFor(tx, items)`), en orden estable de `itemId` para no cruzarse con otras anulaciones; las ventas tomarían el lock y esperarían, y el chequeo ve todo lo ya confirmado. Un `db-spec` con dos transacciones (la anulación retenida tras el chequeo y una venta que debe esperar) lo cierra. Alternativa mínima: repetir el chequeo dentro de `reverse` cuando el original sea IN de producto, ya bajo lock.

## P3

### P3-A. Deriva de redondeo que antes no existía

- Dónde: `inventory.service.ts:1615` (`stockAfterReverseIn`) y el promedio guardado a 4 decimales (`avgOf`/`writeBalance`).
- Escenario: con la compra B viva detrás, `value = qty × avgCost` se recompone de un promedio redondeado; al anular A queda `value − origValue` con un error de hasta `qty × 0,00005`. Con unos 100 000 u son soles de diferencia en el valorizado, o, en el otro signo, un `ConflictException` espurio («sacaría X de un saldo valorizado…, revisa los movimientos posteriores») que el usuario no sabe leer. Antes, B bloqueaba y nunca se llegaba acá. La misma deriva ya se acepta en `replaceEntry` (el E2E asserta el aviso «±0,0001»), así que es coherente, pero no está dicho en la vista previa de anular.
- Arreglo: aceptarlo y documentarlo en D-382, o agregar a la confirmación de anular el mismo aviso de redondeo que da «Editar compra» cuando hay existencias ajenas.

### P3-B. Las pruebas del COIL y del tipo ADJUST no se prueban contra la base

- Dónde: `purchase-cancel.spec.ts` («producto terminado: solo lo que no es entrada…») y `purchase-cancel.db-spec.ts`.
- La regla «en COIL todo bloquea» y «ADJUST ajeno en producto bloquea» solo se verifican como **forma del `where`** (igualdad contra un objeto literal que repite la implementación). El db-spec cubre producto con OUT, OUT anulada y entradas, pero no: (a) una entrada ajena posterior sobre una bobina (la razón dada para no relajar COIL), (b) un `ADJUST` ajeno posterior sobre un producto. Una regresión que quitara el `itemType` del mapa dejaría el test de forma verde y el comportamiento roto solo en el caso COIL.
- Arreglo: dos casos más en el db-spec (itemType `COIL`, entrada ajena posterior, `blockingFor` devuelve esa fila; ADJUST de producto bloquea).

### P3-C. El E2E «con una reserva» no prueba el cambio ni la reserva

- Dónde: `e2e/tests/editar-compra-recibida-cc15b.spec.ts`, segunda mitad del test P2-2.
- La compra `third` es la **última** del producto, así que no tiene ninguna entrada ajena posterior: pasaría igual con el código anterior al commit. Además solo se asserta el saldo final (10), no que la reserva exista (el comentario admite que el pedido directo reserva, pero no se lee el ledger), y no hay un caso inverso (reserva que el saldo final no cubre: debe rechazar con D-066). Lo que se llama «D-066 se comprueba en la reversa» no queda probado.
- Arreglo: anular una compra con una entrada ajena posterior **y** una reserva mayor que el saldo final (espera 400 nombrando el pedido), más otro caso donde sí cubre. Es el único camino donde el cambio y la invariante se tocan.

### P3 (menor, informativo)

- `laterMovementsWhere` consulta por `itemId` sin `itemType` (también antes). UUID distintos entre tipos hacen que no choque; no es nuevo.
- El test «nunca bloquea más que antes» construye la regla anterior con la misma `lastOwnMovementByLiveItem`: no es independiente, y su último `expect` (`extra.type !== undefined`) es débil. Sirve de centinela de forma, no de propiedad.
- Reporte PEPS (`kardex-peps`): una reversa que cae sobre una capa distinta de la propia (entrada ajena más antigua por fecha) se atribuye por orden de capas; es solo del reporte, y el mismo efecto ya existía con `replaceEntry`.

---

## Lo que intenté romper y no pude

1. **Saldo negativo en alguna fecha.** La reversa se fecha hoy (D-124) y tiene el id más alto, así que el saldo corrido solo baja en el último punto, y ahí el mínimo es el saldo final, que `reverse` exige `>= 0` (`origQty > qty` rechaza). Una entrada ajena posterior solo suma. Con fecha retroactiva (solo ADMIN), `assertChronological` rechaza si hay cualquier movimiento con fecha posterior, y `cancel` no pasa `confirmBackdate`: no hay camino a un hueco negativo.
2. **Costo promedio.** La reversa saca exactamente el `totalCost` que el ingreso metió; las entradas posteriores son aditivas en valor, así que el remanente es exactamente la suma de las ajenas (salvo redondeo, P3-A). Cualquier salida o ajuste vivo posterior sigue bloqueando, que es lo que contaminaría el promedio. Probé un ADJUST propio después de la entrada ajena (corrección proporcional de cc15): la reversa del ajuste usa `min(saldo, qty del ajuste)`, y como el saldo solo creció, saca el ajuste completo; correcto.
3. **Entradas que no son inocuas.** Tipos de movimiento: solo `IN`, `OUT`, `ADJUST`. Las reversas de salidas son `IN` con `reversalOfId`, pero ya quedaban fuera de la consulta por `reversalOfId: null` (y la salida revertida por `reversals: none`): no cambian de categoría. Las entradas de producción de producto terminado (`production.service.ts:718`, `roofing-production.service.ts:1252`) consumen **bobina o flejes**, que son otro `itemId`/`itemType` y siguen bloqueando por su cuenta; el IN de producto es aditivo. Restauración de reservas (`reservation-restore.ts:269`) es IN de producto: aditivo.
4. **Tapar una salida con el límite de filas.** El filtro `type != IN` va en el `where`, antes de `take: 5`, y el db-spec «seis entradas…» lo prueba (la salida es la fila 7 por id). Correcto.
5. **Reservas (D-066).** `reverse` comprueba `assertReservationInvariant` sobre el saldo final con la entrada ajena ya sumada; si esa entrada cubre la reserva, es correcto que pase; si no, rechaza y la transacción de `cancel` hace rollback completo (incluido el `updateMany` del estado). Probé el desorden de orden de reversas con varias líneas del mismo producto: se revierten de la más nueva a la más vieja y cada paso comprueba su estado.
6. **Materia prima prometida (D-134) y bobinas canceladas con saldo.** En COIL la consulta es idéntica a la anterior (cualquier posterior vivo bloquea), `itemTypes.get(itemId)` se arma desde los movimientos propios y un `itemId` no puede ser PRODUCT y COIL a la vez. `assertRawMaterialInvariant` en `reverse` queda intacto. Las bobinas en corte tercerizado y los flejes montados en OP siguen cubiertos por sus chequeos separados, que el cambio no toca.
7. **Otros llamadores.** `assertNothingMovedAfter` solo se llama desde `cancel`. El clasificador de «Editar compra» (`purchase-received-edit.service.ts` ~401-437) y `replaceEntry` usan su propia regla (id **o** fecha, y excluyen `IN`); la anulación usa solo id, pero como la reversa se fecha hoy y una salida retroactiva ya la frena `assertChronological` al registrarse, no hallé un caso que pase la anulación y rompa el kardex.
8. **Foto de producción.** Coincide con el razonamiento: la relajación solo puede quitar bloqueos de tipo `IN` sobre producto; nada pasa de anulable a bloqueado, y E001-1766 la sigue parando la reversa por reservas.
9. **Tests.** El db-spec 1 prueba de verdad el P2-2 (sin el cambio el reingreso, `IN` con id mayor, bloqueaba) y verifica saldo 10 a 27; el 2, 3 y 4 prueban salida viva, salida anulada y el límite de filas. Las debilidades están en P3-B y P3-C.

## Respuesta del autor (2026-10-03)

- **P2-A, corregido.** `cancel` bloquea los saldos de los productos de la compra (orden fijo por id, `lockAvailability`) **antes** de buscar movimientos posteriores, así que una venta concurrente espera y, cuando la anulación libera el lock, la ve como salida posterior, o el guardrail ya la vio. Las bobinas no se bloquean ahí: su guardrail no cambió y D-134 pide tomarlas antes que los saldos (lo hace `reverse`). Test unitario de orden en `purchases.service.create-in-tx.spec.ts` (sin el lock, falla). No agregué un db-spec de dos transacciones: el lock es el mismo `FOR UPDATE` del saldo que ya prueban los db-spec de `replaceEntry`, y armar `PurchasesService` contra la base exige su contenedor completo.
- **P3-A, aceptado sin cambio:** la deriva a ±0,0001 es la misma que `replaceEntry` avisa en la vista previa; la anulación no tiene vista previa. Queda anotado.
- **P3-B, aceptado:** la regla de bobina y la del `ADJUST` ajeno en producto se prueban como forma de la consulta (unitario), más el test de que la regla nueva nunca bloquea más que la de antes.
- **P3-C, corregido:** se quitó del E2E la mitad que no probaba el cambio.

---

## Verificación del arreglo de P2-A

Commit revisado: `ee30dab` (solo lectura).

**Cierra el P2-A para producto.** `cancel` toma `lockAvailability` (el `FOR UPDATE` del saldo) de cada PRODUCT de la compra, en orden de id, después de que `updateMany` tomó la fila de la compra y antes de `assertNothingMovedAfter`. Una venta concurrente del mismo SKU espera o ya está confirmada y el chequeo la ve. `reverse` vuelve a pedir el mismo saldo en la misma transacción: el lock es reentrante, no hay deadlock. El orden entre productos es el mismo que usa «Editar compra» (`purchase-received-edit.service.ts` ~254) y ambas toman primero la fila de la compra, así que se serializan entre sí. El spec unitario prueba el orden `own, lock:a, lock:b, later`, pero con mocks: no prueba el bloqueo real contra una venta (sigue faltando el db-spec de dos transacciones, mejora opcional).

**Abre un riesgo de deadlock nuevo en compras que mezclan bobina y producto (P2-B).** D-134 fija el orden «primero las bobinas, después los saldos» (`lockRawMaterialCoils`, `sales/raw-material.ts:853`). `cancel` ahora toma saldos de producto y recién después, dentro del bucle de `reverse`, las bobinas (`inventory.service.ts:479`, y la reversa del IN de bobina). Escenario: T1 anula una compra con la bobina C y el accesorio P: ya tiene el saldo de P y pide las filas de coil. T2 confirma un pedido (o reporta producción) que toma las bobinas del agregado y luego `lockAvailability` de P: tiene las coils y pide P. Ciclo. Es estrecho (mismo producto P en ambos, y T2 con material prima), pero «Editar compra» ya cerró exactamente este caso con `lockRawMaterialCoils` primero. Antes del commit el orden dependía del id de cada movimiento (también podía invertirse), ahora el inverso queda garantizado en una compra mixta.
Arreglo: en `cancel`, antes del bucle de saldos, si la compra tiene bobinas, `await lockRawMaterialCoils(tx, <ids de coil de la compra, ordenados>, roofingToleranceMm(this.env))` (igual que `purchase-received-edit.service.ts:126`); luego los saldos de producto. Compras solo de producto o solo de bobina no cambian.

Sin hallazgos nuevos sobre el orden entre productos (ids UUID, mismo comparador en ambos servicios).

### Respuesta del autor a P2-B (2026-10-03)

Corregido. `InventoryService.lockItemsForReversal` toma primero las bobinas de los movimientos de la compra (`lockRawMaterialCoils`, ordenadas, con la tolerancia de `this.env`) y después cada saldo una sola vez, en orden fijo. `cancel` la llama con todos los movimientos propios antes del guardrail. Así cubre la compra mixta, aunque hoy una compra es de bobina, de producto o de servicio y no mezcla tipos. Tests unitarios: el orden bobinas antes que saldos y sin bobinas no las lee (`inventory.service.spec.ts`); el de `cancel`, que el bloqueo va antes de la búsqueda (`purchases.service.create-in-tx.spec.ts`). Sigue sin db-spec de dos transacciones, igual que antes.
