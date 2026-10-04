# cc18 — Mapa de bloqueos (PASO 0, D-386)

Fecha: 2026-10-04. Base: `main` `9d88277`. Relevado leyendo el código antes de tocarlo; las columnas
«después» describen el estado de la rama `cc18/orden-bloqueos`.

## Orden canónico confirmado en el código

Lo que ya hacían confirmar un pedido (`reserveLines`), la anulación de compra (D-382), «Editar
compra» y el reporte de producción, y lo que D-386 vuelve regla:

1. **Documentos.** La OP antes que el pedido (`production.report`/`reportInTx`: OP → pedido); el
   pedido antes que sus reservas (`SalesOrdersService.cancel`, restaurar reserva); el despacho antes
   que su pedido (reversa); la compra sola (anular, «Editar compra»). **Desempate:** una sola fila,
   o varias por id ascendente en una sentencia (`ORDER BY "id" FOR UPDATE`).
2. **Reservas**, por id ascendente en una sentencia.
3. **Bobinas**: el conjunto entero —las nombradas y las de cada agregado con promesas vivas que
   alcanzan (`rawMaterialLockSet`)— en **una sola** sentencia por id ascendente. El orden de un
   `uuid` en Postgres es el de sus bytes y coincide con comparar el texto hexadecimal en
   minúsculas por unidades de código (`compareLockKeys`); `localeCompare` daba lo mismo sobre
   estos textos, pero la puerta ya no lo usa.
4. **Saldos** (`inventory_balances`), uno por uno, por la clave `itemType:itemId` (`COIL` antes
   que `PRODUCT`), sin duplicados.

## Qué hace la API ante 40P01 / 40001 (antes de cc18)

No había filtro global de excepciones (`main.ts` y `app.module.ts` sin `APP_FILTER` ni
`useGlobalFilters`). Prisma entrega el aborto como `PrismaClientKnownRequestError` `P2010` (en
`$queryRaw`, con `meta.code` = `40P01`) o `P2034` (cliente tipado); Nest no lo reconoce como
`HttpException` y responde **500 «Internal server error»**, sin mensaje para el usuario. Desde M3b:
409 «Otra operación estaba usando este inventario. Vuelve a intentarlo.», sin reintento.

## Caminos que toman bloqueos de fila sobre documentos, bobinas o saldos

`agg` = la bobina más las de su agregado con promesas vivas (`lockRawMaterialCoils`). «Puerta» =
`InventoryService.lockInOrder`.

| Operación                                                                        | Archivo · función                                          | Antes de cc18 (orden de toma)                                                                                                                                             | Después                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Anular compra                                                                    | `purchases.service.ts` · `cancel`                          | compra → bobinas+agg (una sentencia) → saldos ordenados; flejes heredados recién en el `updateMany` (P3-1)                                                                | igual, más los flejes con `purchaseId` en la toma inicial (M4)           |
| «Editar compra»                                                                  | `purchase-received-edit.service.ts` · `commit`             | compra → bobinas por `purchaseId`+agg → saldos ordenados (`lockAvailability`)                                                                                             | igual (bobinas por la puerta única)                                      |
| `replaceEntry` / `reverse` / `record` OUT de bobina                              | `inventory.service.ts`                                     | agg → saldo; segunda toma reentrante que podía ampliar el conjunto (P3-2)                                                                                                 | igual; una ampliación fuera de orden va con `NOWAIT` (M4)                |
| Confirmar pedido / agregar ítems / cambiar cantidad o bobina / completar reserva | `sales-orders.service.ts` · `reserveLines`                 | pedido → (reservas) → bobinas nombradas ∪ agregados de lo genérico (una sentencia) → saldos ordenados → **el guardrail tomaba el agregado de las nombradas después** (A5) | las nombradas entran con su agregado en la misma sentencia (M3)          |
| Restaurar reserva                                                                | `sales-orders.service.ts`                                  | pedido → reserva → saldo                                                                                                                                                  | igual                                                                    |
| Anular pedido                                                                    | `sales-orders.service.ts` · `cancel`                       | pedido → reservas (id) → borradores (id) → OP en borrador (`updateMany`)                                                                                                  | igual (no toca kardex)                                                   |
| **Despacho**                                                                     | `dispatches.service.ts` · `createInTx`                     | pedido → bobinas nombradas → por línea, en el orden de las líneas: reserva (UPDATE) → agg+saldo (P2-1)                                                                    | pedido → reservas (id) → bobinas+agg → saldos (M2)                       |
| **Reversa de despacho** (y anular venta de mostrador)                            | `dispatches.service.ts` · `reverseInTx`                    | despacho → pedido → bobinas → por ítem en orden de línea: saldo → reserva (P2-2)                                                                                          | despacho → pedido → reservas → bobinas+agg → saldos (M2)                 |
| Drywall: reportar                                                                | `production.service.ts` · `report`                         | OP → pedido → reserva → por asignación (orden de montaje): fleje → agg+saldo; saldo del producto                                                                          | OP → pedido → reserva → flejes+agg → saldos (M3)                         |
| Drywall: cerrar                                                                  | `production.service.ts` · `close`                          | OP → por fila (orden de montaje): fleje → saldo; producto                                                                                                                 | OP → flejes+agg → saldos (M3)                                            |
| Drywall: revertir reporte                                                        | `production.service.ts` · `reverseReport`                  | OP → **saldo del producto → flejes** (orden inverso)                                                                                                                      | OP → flejes+agg → saldos, antes del guardrail (M3)                       |
| Drywall: reabrir                                                                 | `production.service.ts` · `reopen`                         | OP → saldo del producto → flejes                                                                                                                                          | OP → flejes+agg → saldos (M3)                                            |
| Coberturas: montar                                                               | `roofing-production.service.ts` · `mountCoil`              | OP → por bobina: bobina (y saldo si se reabre) → agregado recién en el guardrail                                                                                          | OP → todas las bobinas+agg → saldos de las que se reabren (M3)           |
| Coberturas: reportar                                                             | `reportInTx`                                               | OP → pedido → reserva → bobina → agg+saldo → producto                                                                                                                     | OP → pedido → reserva → **todas** las bobinas montadas+agg → saldos (M3) |
| Coberturas: cerrar / reportar y cerrar / borradores                              | `closeInTx`, `reportAndClose`, `roofing-drafts.service.ts` | por asignación: bobina → agg+saldo, con saldos del reporte ya en mano                                                                                                     | pedido → reserva → bobinas+agg → saldos de una vez (M3)                  |
| Coberturas: revertir reporte                                                     | `reverseReport`                                            | OP → reserva del producto (UPDATE) → **saldo del producto → bobina**                                                                                                      | OP → reserva (FOR UPDATE) → bobinas+agg → saldos (M3)                    |
| Coberturas: reabrir                                                              | `reopen`                                                   | OP → saldo del producto → bobinas                                                                                                                                         | OP → bobinas+agg → saldos (M3)                                           |
| Corte: enviar                                                                    | `cutting.service.ts` · `send`                              | bobinas (una sentencia)                                                                                                                                                   | igual (puerta única)                                                     |
| Corte: recibir                                                                   | `receive`                                                  | fila de corte → madre (`lockCoil`) → agg+saldo                                                                                                                            | igual; `lockCoil` toma la madre con su agregado (A6)                     |
| Corte: revertir recepción                                                        | `reverse`                                                  | fila de corte → madre → por fleje: agg+saldo → madre                                                                                                                      | fila de corte → madre y flejes+agg → saldos (M3)                         |
| Corte: anular orden                                                              | `cancel`                                                   | orden → por fila, **sin orden**: UPDATE de la fila de corte → bobina (corregido por la revisión de segundo modelo)                                                        | orden → filas pendientes (id) → todas las bobinas en una sentencia (M3)  |
| Bobina: partir / mermar / cerrar / reabrir / editar / anular / film              | `coil-operations.service.ts`, `coil-film.service.ts`       | `lockCoil` (la bobina sola) → agg recién en `record`/guardrail                                                                                                            | `lockCoil` con su agregado (A6)                                          |
| Bobina: revertir partido                                                         | `coil-operations.service.ts` · `revertSplit`               | madre → hijas una por una                                                                                                                                                 | madre e hijas+agg → saldos (M3)                                          |
| Restaurar bobina / deshacer lote                                                 | `coil-restore.ts`                                          | por ítem, **sin orden**: bobina → reversa                                                                                                                                 | todas+agg → saldos (M3)                                                  |
| Corrección de fechas de compra (CLI)                                             | `purchase-received-date-fix.ts`                            | bobinas+agg → saldos con `FOR UPDATE` propio                                                                                                                              | por la puerta (M1)                                                       |
| Mostrador: vender                                                                | `pos.service.ts`                                           | turno → pedido → reservas (saldos ordenados) → despacho                                                                                                                   | igual (el despacho por M2)                                               |

## Fuera de alcance, anotado en PROGRESO como pieza propia

**Grupo C — orden de bloqueos entre documentos (OP, pedido, reserva):** la reversa de reporte de
drywall restaura la reserva y escribe el pedido **después** de los saldos (`restoreReservation`:
reserva → pedido) mientras anular el pedido va pedido → reservas; `updateItemQty` va pedido →
reservas → bobinas → OP, mientras coberturas va OP → pedido; el cierre de coberturas libera la
reserva después de los saldos. Decisión del dueño: pieza propia.
