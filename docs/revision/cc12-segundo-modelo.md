# Revisión de segundo modelo — cc12 (D-379, restaurar reserva)

## Alcance

Rama `cc12/restaurar-reserva`, diff `origin/main...HEAD` (4 commits: baa1022, 9168e2f, 3bbe0d2, 3dd81f0), 17 archivos. Revisados API (`reservation-restore.ts`, `sales-orders.service.ts`, `sales.controller.ts`, `invoice-dispatch.service.ts`), schemas compartidos, web (pedido y comprobante) y specs. Se recorrieron todas las rutas que liberan o reviven reservas (`sales-orders.service.ts` anular/liberar/upsert, `reservation-guard.ts`, `reservation-transfer.ts`, `sales-order-edits.service.ts`). `npx tsc --noEmit` en apps/api limpio; jest de `reservation-restore`, `order-shortfall` e `invoice-dispatch.service` en verde (102 tests). No se corrió E2E.

## Veredicto

**Aprobado con correcciones menores: 0 P0, 0 P1.** La heurística que separa la liberación manual (cantidad intacta + último evento de auditoría `sales.reservation.release`) resiste el recorrido de rutas; los locks y la invariante están bien. Hay un P2 de regresión de interfaz para vendedores y dos P2 de endurecimiento.

## Verificación de la distinción «liberación manual»

Rutas que dejan `RELEASED`: anular pedido (`sales-orders.service.ts:2292`), `releaseRemainingReservation` (`reservation-guard.ts:247`), `reduceReservation` (`reservation-transfer.ts:124`), cambio de bobina (`sales-order-edits.service.ts:410`) y cambio de cantidad (`:755`). Todas ponen `qty: '0'`. Solo la liberación manual (`:2412`) conserva `qty`, y es la única que escribe `sales.reservation.release` (el literal solo aparece ahí). Las que revivían (`upsertItemReservation`, `upsert` de transferencia) dejan la fila `ACTIVE`, y `restoreBlock` rechaza por estado. Una reserva liberada a mano y luego revivida y luego cerrada por otra ruta queda con `qty = 0` o `CONSUMED`. Conclusión: la distinción es correcta sin migración.

Locks: restaurar toma pedido, fila de reserva, saldo (`lockAvailability`), el mismo orden que el resto. El `updateMany` con guarda `status: RELEASED` cubre la carrera con otra liberación o restauración. La unicidad `(línea, ítem, tipo)` impide duplicados. La invariante disponible ≥ reservado se comprueba contra `physical - reserved ACTIVE`, y la fila liberada no cuenta en lo reservado, así que no se cuenta dos veces.

## Hallazgos

### 1. P2 — Regresión de interfaz para el vendedor dueño: `primary={canEditAsAdmin ? 'price' : null}`

`apps/web/src/app/(app)/pedidos/[id]/pedido-detalle-view.tsx` (~línea 596).
Antes, `primary="price"` con «Precio» oculto caía en la primera acción visible (Cantidad o Bobina) como botón. Ahora, un vendedor no administrador (`canEditAsOwner`) recibe `null`: «Cantidad» y «Bobina» pasan al menú ⋯. Cualquier spec E2E de vendedor que haga clic directo en «Cantidad» se rompe, y es un cambio de UX no pedido por D-379.
Sugerencia: `primary={canEditAsAdmin ? 'price' : canEditAsOwner ? undefined : null}` (el `null` solo cuando lo único visible es «Restaurar reserva»).

### 2. P2 — `restoreReservation` no revalida que la reserva siga siendo la de lo fabricado de la línea

`sales-orders.service.ts` (~2466-2500) y `reservation-restore.ts:139-162`, `restorableReservationIds`.
`restoreBlock` no llama a `isFabricatedLineReservation` ni comprueba que `reservation.itemId` coincida con la línea. Solo `restorableByLine` filtra por fabricada. Si una línea cambió de producto o de ítem de respaldo después de la liberación manual, la fila vieja (`RELEASED`, `qty>0`, último evento «release») sigue siendo «restaurable» y reviviría una promesa sobre un ítem que la línea ya no usa. Los edits solo liberan filas `ACTIVE`, así que la fila vieja conserva la cantidad. Es un caso raro, pero la restauración inventaría un compromiso (regla 10/15 del espíritu del repo).
Sugerencia: en `restoreReservation` y `restorableReservationIds`, exigir que `reservation.itemId === line.productId` (o `isFabricatedLineReservation`). Con eso quedaría coherente con el texto de la decisión («producto terminado de la línea»). Si se quiere aceptar también productos de stock, exigir al menos `itemId === line.productId` o `reserveItemId`.

### 3. P2 — Reserva liberada a mano de antes de D-379 y producción posterior: la cantidad vieja se suma

`reservation-transfer.ts:60-86` (`upsertItemReservation`, `qty = existing.qty + input.qty`).
Preexistente, pero la entrega la deja viva para las filas históricas (como la del 1382): una fila `RELEASED` con `qty>0` que recibe un reporte de producción posterior suma la cantidad estancada de la liberación a la nueva y la revive `ACTIVE` con una cifra inflada, sin pasar por la comprobación de disponible. El bloqueo nuevo impide crear casos futuros, pero no limpia los existentes, y el runbook solo restaura el 1382.
Sugerencia: registrar en el handoff que no se debe correr producción sobre esas líneas antes de restaurarlas, o que el `update` de `upsertItemReservation` parta de cero cuando la fila está `RELEASED`.

### 4. P3 — Carrera menor en el bloqueo de liberar

`sales-orders.service.ts:2362-2397`. `releaseReservation` lee la reserva sin lock y evalúa `fabricatedReleaseBlock` sobre esa lectura; una transferencia de producción concurrente podría subir `qty` entre la lectura y el `updateMany` (que solo guarda por estado). Ventana mínima y requiere dos operaciones simultáneas. Sugerencia opcional: `FOR UPDATE` de la fila antes de evaluar, como en restaurar.

### 5. P3 — El efecto del parámetro de URL se consume una sola vez, con datos posiblemente viejos

`pedido-detalle-view.tsx`, `useEffect` de `restoreParamHandled`. Si el pedido viene de caché de TanStack Query antes del refetch, `r.restorable` puede estar desactualizado y el diálogo no abre ni se reintenta, porque el ref ya quedó marcado. Tampoco se reinicia al cambiar de `id` en el mismo componente. Sugerencia: marcar el ref solo cuando se abre, o cuando `order.isFetching` sea falso.

### 6. P3 — Etiqueta de auditoría faltante

`apps/web/src/lib/audit-labels.ts:119` tiene `sales.reservation.release` pero no `sales.reservation.restore`; la pantalla de auditoría mostrará la clave cruda.

### 7. P3 — Texto del enlace del comprobante

`dispatch-at-issue-date.tsx`: el aviso «se liberó a mano» se muestra para cualquier línea REVIEW con reserva restaurable, aunque el motivo del REVIEW sea otro (por ejemplo kardex negativo). Con la reserva liberada la línea no tiene camino de despacho, así que es coherente, pero el motivo mostrado y el aviso pueden contradecirse. Solo claridad.

## Sobre los tests

Los unitarios prueban lo que dicen (reglas puras, orden de locks, 409 por cambio de fila, 403, faltante sin escrituras). Lo que no cubren, y conviene agregar con el hallazgo 2: una reserva liberada a mano cuya línea cambió de producto no debe aparecer como restaurable. Los mocks de `restoreReservation` no ejercitan la unicidad ni el aggregate de despachos reales; eso queda en el E2E (`restaurar-reserva-d379.spec.ts`, no corrido en esta revisión).

## Resumen P0/P1

Ninguno. P2: tres (regresión de «Cantidad» como botón para el vendedor dueño; falta de revalidación del ítem de la línea al restaurar; cantidad estancada que suma `upsertItemReservation` en filas históricas).

## Resolución (sesión que implementó)

- **Hallazgo 1:** corregido; la acción principal es la de siempre cuando hay ediciones.
- **Hallazgo 2:** corregido; `restoreBlock` exige la reserva de lo fabricado del producto que la línea vende hoy. Hay test del cambio de producto y de la reserva de stock.
- **Hallazgo 3:** corregido; `upsertItemReservation` revive una RELEASED desde cero. Hay test.
- **Hallazgos 5 y 6:** corregidos; el parámetro de URL se limpia al consumirse y se agregó la etiqueta de auditoría.
- **Hallazgos 4 y 7:** aceptados.
  - La carrera del bloqueo deja, a lo sumo, liberar algo que un despacho acaba de consumir; el `updateMany` con `status: ACTIVE` la cierra.
  - El texto del enlace se mantiene.
- **Además, por la autorrevisión (P1-1):** restaurar se topa por lo fabricado vivo de la línea (`fabricatedAliveQty`).
