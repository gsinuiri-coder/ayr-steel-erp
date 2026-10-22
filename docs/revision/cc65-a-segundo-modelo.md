# Revisión de segundo modelo — cc65-a (D-697: mostrador vende cobertura terminada)

Alcance: `git diff origin/main...HEAD` (pos.service, sales-lines, sales-orders.service, sales-order-edits.service, schema `counter`, pos-view, tres specs, un e2e). Revisión estática (no se corrieron pruebas). Sin P0 ni P1.

## Qué se comprobó y está bien

- Cotizaciones, pedidos y OP normales no cambian: `fromFinishedStock` solo lo pasa `createDirectInTx` con `counterSale` (`sales-orders.service.ts:1433`), y `servedFromFinishedStock` exige la opción. La cola de OPs (`findLinesWithoutOrder`, `confirm`) filtra por reserva `RAW_MATERIAL`, así que una línea PRODUCT sin OP no entra a producción.
- Despacho: `resolveDispatchTarget` ve `backedByProduct` y no entra en la rama «se fabrica contra el pedido»; sale al promedio del saldo por `InventoryService`. `reservation-restore` (`isFabricatedLineReservation`) excluye líneas respaldadas por su producto, así que D-379 no las bloquea ni las restaura mal.
- `voidSale`, NC con devolución y anulación de pedido tratan la línea como cualquier producto de stock (no hay lógica por `roofingKind` en `sales-returns`/`dispatches`).
- Lo reservado no se vende: `findProducts` y `createReservations` descuentan `reservedByItem` (firme + temporal).
- El vendedor no ve costos: `showCost` sigue siendo solo ADMINISTRADOR; el panel con `counter=1` no agrega campos de costo.
- La ventana de `findProducts` (`AND:[OR]` separado del `OR` de búsqueda) es correcta.

## Hallazgos

**R-01 — P2 — Pruebas: «lo reservado no se vende» no cubre el caso real.** `pos-finished-stock.db-spec.ts` (test «lo reservado a un pedido…») reserva con otro `createDirectInTx` de mostrador. El escenario de negocio es el sobrante de una OP con reserva PRODUCT abierta por producción (pedido con cotización). Escenario: stock 2 m reservado por la OP del pedido X; el mostrador vende 1 m. Hoy el código lo rechaza (la reserva cuenta), pero ningún test lo prueba con la reserva que abre producción. Recomendación: agregar un caso que cree la reserva PRODUCT por el camino de producción/`createReservations` de un pedido normal.

**R-02 — P2 — Pruebas: sin cobertura de NC con devolución, despacho parcial ni reportes con la línea de cobertura sin OP.** Solo se prueba `voidSale` (A_MEDIDA) y el margen de ventas. Falta: NC con devolución sobre una línea de accesorio/plancha vendida en mostrador (reingreso al costo de la salida, `recostForward` si hay recosteo), y el efecto en «Ventas por material». Recomendación: un caso de `createCreditNote` con devolución y asserts de saldo/valor del kardex.

**R-03 — P3 — Reporte «Ventas por material»: la línea de mostrador sale como `DESDE_STOCK` (no trazable).** `sales-by-material.ts:traceFraction` (≈ líneas 262-268) la clasifica por `orderCount === 0 && dispatched > 0`. Es un comportamiento ya previsto, pero ahora un volumen nuevo de ventas de cobertura entra a «sin trazar» sin costo ni kg. Recomendación: declarar la consecuencia en el handoff/UAT (el costo de estas ventas está en «Ventas y margen», no en «por material»).

**R-04 — P3 — Pruebas: no se asierta que el vendedor no ve el costo.** El test usa `seller` solo en el camino feliz. Un rechazo de piso con rol VENDEDOR no se prueba para esta línea (el mensaje no debe traer el costo, cc55 D-664). Recomendación: un caso con precio bajo el piso con `seller` y `expect(message).not.toMatch(/costo/i)` de cifra.

**R-05 — P3 — `assertUsableFixedLength` sigue corriendo para una plancha vendida del stock** (`sales-lines.ts` ≈ línea 472). Una plancha con `lengthMm` mal cargado (D-166) no se podrá vender en mostrador aunque el largo no se use. Es conservador y coherente con el catálogo; solo conviene saberlo (el mensaje manda a corregir el maestro).

**R-06 — P3 — `counter=1` en `/sales/stock-panel` lo puede pedir cualquier rol con acceso al panel.** No expone costo ni nada nuevo (solo cambia el disponible/ base a unidad); sin riesgo de seguridad. Para evitar que la UI de cotización muestre por error el saldo terminado, el flag solo debería mandarlo el mostrador (así está). Sin acción obligatoria.

**R-07 — P3 — Guardia de `lockEditable` parcialmente redundante.** El pedido del mostrador ya nace con comprobante y por tanto queda fuera de la edición por la regla siguiente (`sales-order-edits.service.ts:1830+`); la nueva guarda solo actúa si ese comprobante se anuló, y entonces el pedido suele estar anulado. Es inofensiva y deja un mensaje claro; el orden pone «nació en el mostrador» antes de «anulado», lo que cambia el mensaje de un pedido de mostrador anulado. Sin acción.

**R-08 — P3 — E2E debilitado.** `fase7b-bordes.spec.ts` quitó `listed.every(p => p.unit !== 'MTR')`. Es correcto por D-697, pero ya no queda aserción de que un producto MTR que no es cobertura (D-098) no se ofrece fuera del `some(...)` anterior (que sí lo cubre). Sin acción.

## Veredicto

Sin P0/P1. Los P2 son de pruebas (R-01, R-02) y conviene cerrarlos antes del deploy o registrarlos como riesgo aceptado por el dueño.

## Respuesta del autor

- **R-01 y R-02:** sin prueba propia de la reserva de producto terminado de una OP, de la NC con devolución ni del
  despacho parcial sobre una línea de mostrador de cobertura; esos caminos tratan la línea como cualquier producto de stock
  (lo confirman las dos revisiones por lectura). Quedan como riesgo anotado en el handoff.
- **R-03:** «Ventas por material» la sigue mostrando como «desde stock», que es correcto (no hay material de OP). Desde
  la autorrevisión (A-01), «Rentabilidad» la costea por el despacho, igual que «Ventas y margen».
- **R-04 a R-08:** sin cambios; R-07 y R-08 aceptados como están.
