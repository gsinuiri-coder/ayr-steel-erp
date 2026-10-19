# Revisión de segundo modelo — cc58 corte B (D-683, D-684, D-685)

Alcance: `git diff cc58-a..cc58-b` (un commit, 3ba78a0f). Revisor: segundo modelo (Sonnet), contexto limpio. No es una aprobación: es una lista de riesgos. Ejecuté `transaction-options.sentinel.spec.ts` y `kardex-peps*.spec.ts` (4 suites, 29 pruebas, verdes). No ejecuté db-specs, así que `recost.db-spec.ts` no está probado por mí.

Resumen: 0 P0, 1 P1, 3 P2, 3 P3.

---

## P1

### P1-1. La salida que agota el ítem pone `avg_cost = 0` y el piso de precio de ese producto desaparece

`apps/api/src/inventory/inventory.service.ts:309-318` (rama nueva `qty.gte(balance.qty)`, `newAvgCost = new Decimal(0)`).

Antes, la salida final dejaba `balance.avgCost` intacto: el último costo conocido seguía en el saldo con cantidad cero. Ahora queda en 0.

Lectores que usan ese último costo con el ítem en cero:

- `apps/api/src/sales/price-floor.ts:384-399` (`unitCosts`) lee `avgCost` del saldo de un PRODUCT o COIL sin mirar la cantidad. En `:177-181`, `cost.lte(0)` devuelve `{ missing: 'NO_COST' }`.
- Resultado: desde que se vende la última unidad de un producto, su piso de margen (D-032) no se aplica en cotizaciones ni en el panel. Eso es justo cuando el vendedor cotiza reposición. Con la lógica anterior el piso seguía al último costo. Antes de este cambio solo ocurría si el ítem llegaba a cero por una retrofecha o por una reversa.
- `coils/coil-close-math.ts:87` y `coil-operations.service.ts:782,940` ya caen al costo del documento cuando `avgCostPen` es 0, así que esos dos sitios aguantan. El piso de precio no.

Escenario: producto P con 10 unidades a S/ 5. Se despachan las 10. Se cotiza P a S/ 4. Antes el piso (costo 5 más margen) lo rechazaba. Ahora `NO_COST` y la cotización pasa.

Arreglo (cualquiera de los dos):

1. Dejar `newAvgCost = balance.avgCost` en la rama nueva. El valor del kardex ya queda en 0 por las filas, y el valorizado es `qty × avg = 0` de todos modos.
2. Si el dueño quiere avg 0 como política, que `price-floor.ts` use el último costo cuando `qty = 0` y que haya un test.

Opción 1 es la mínima y no cambia nada más. Hay que revisar a la vez si el `recost.db-spec.ts` nuevo debe seguir esperando `{ qty: '0', avg: '0' }` (`recost.db-spec.ts` ~l. 667 del diff).

---

## P2

### P2-1. `mountCoil` pierde la escala por bobina (antes 30 s + 3 s por bobina extra)

`apps/api/src/production/roofing-production.service.ts:~864-866`.

Hasta 20 bobinas por montaje (`MAX_ORDER_STRIPS_TO_MOUNT = 20`, `packages/shared/src/schemas/roofing.ts:82`). Antes el tope era 30 + 3×19 = 87 s. Ahora es 30 s fijos. El comentario que se conserva ("Cada bobina suma su lock, sus lecturas y su asignación: el presupuesto crece con ellas") ya no describe el código. No se recostea nada, así que la clasificación como "operación del día" es correcta. Pero el costo sí crece con N: bloqueos de bobina y saldo, lecturas y una auditoría por bobina, más el chequeo de materia prima, que se hace una sola vez.

Riesgo: montar 15-20 bobinas contra Neon desde Cloud Run puede pasar de 30 s y salir con P2028, con todo o nada. No lo medí. Recomendación: medir un montaje de 20 bobinas en demo antes del deploy. Si pasa de ~20 s, pedir al dueño que acepte que el tope por bobina sea una excepción con nombre en el centinela, o bajar `MAX_ORDER_STRIPS_TO_MOUNT`. Corregir además el comentario.

### P2-2. Se bajó el tope de operaciones que antes tenían 120 s a 60 s sin medición

- `purchases/purchases.service.ts:~975` (cancel, antes 120 s).
- `purchases/purchase-received-edit.service.ts:~229` (commit, antes 120 s).
- `production/roofing-drafts.service.ts:~215` (commit del borrador, antes 120 s).
- `production/close-preview.ts` (`COMMIT_PREVIEW_TIMEOUT_MS` 120 s a 60 s).

El 120 s lo habían puesto sesiones anteriores con un motivo (cc28: "el tope de la vista previa es el de su acción real"). Una compra con muchas líneas que dispara `recostForward` por ítem (hasta 500 movimientos por ítem, D-649) es el caso más caro del sistema. La decisión del dueño fija 60 s, y la clasificación es correcta: todas recostean en bloque. El riesgo es operativo: un P2028 en la anulación o edición de una compra grande deja la acción imposible sin vía alternativa. Recomendación: medir en demo la compra más grande real (o `seed-escenarios`) y dejar la cifra en el handoff. Si una pasa de ~40 s, subirla a excepción con nombre. La excepción es barata, y el centinela ya tiene lista de excepciones.

### P2-3. El comentario del montaje y el de la vista previa quedaron inconsistentes con el código

`close-preview.ts` aún cita en su cabecera "120 s el borrador, 60 s los cierres" en un bloque que el diff solo parcialmente reescribió (el diff cambia el comentario de arriba, pero conviene releer el resto). `mountCoil` conserva el comentario de crecimiento por bobina (ver P2-1). Son comentarios, pero confunden al próximo que ajuste topes y el centinela no los comprueba. Severidad P2 solo porque la decisión se apoya en ellos.

---

## P3

### P3-1. Costo de consultas de la rama nueva de `record()`

`inventory.service.ts:309-312`: cada salida que agota el ítem hace `stockUpToDate(KARDEX_END)`, que carga todo el historial del ítem (`loadItem`: movimientos más recosteos). Ítems con miles de filas que llegan a cero seguido (coberturas, bobinas al cerrar) pagan una lectura grande dentro de la transacción de despacho. No es un defecto de corrección. Conviene medirlo (hay presupuesto de consultas) y comprobar que ningún test de presupuesto de despacho o de corte de bobina cambia de conteo. Corre una consulta más en un camino caliente.

### P3-2. `unitCost` queda como `totalCost / qty` redondeado a 4 decimales

`inventory.service.ts:313`. `unitCost × qty` puede no igualar `totalCost` en ± `qty × 0,00005`. Ya pasaba con la rama de retrofecha. Quien reconstruya valor con `unit_cost × qty` en vez de `total_cost` verá diferencia de céntimos. No hay consumidor conocido que lo haga para salidas.

### P3-3. PEPS: el reporte de un período cerrado cambia retroactivamente

`kardex-peps.service.ts:156-160` y `:173-189`. Las filas de recosteo llevan la fecha de su entrada original (`inventory.service.ts:527`), así que el filtro `operationDate <= to` las incluye cuando la entrada está en rango. Un flete que llega en octubre cambia el saldo inicial y las salidas PEPS de un reporte SUNAT de agosto ya presentado. Es coherente con D-685 (costo corregido), pero es un cambio de contrato para un reporte de presentación: el handoff debería decirlo.

---

## Verificado sin hallazgo

### B-03 (D-683)

- Sentinela: `RECOST_PATHS`, `BULK_EXCEPTIONS`, techo de 30 s y 60 s y comprobación de que las listas no apuntan a caminos que ya no existen. Pasa verde. Entra en la lista de recosteo todo lo que lo necesita según mi lectura: `cancel`/`commit` de compras, `close`/`reopen` de producción y roofing, `reportAndClose`, `previewPlantClose`, `updateManualIssueDateInTx`, `executeForInvoice` (despacho a la fecha del comprobante, que re-fecha y recostea).
- Las rebajas a 30 s (`KARDEX_TX_OPTIONS`) de confirmar pedido, `restoreReservation`/`completeReservation`, `addItems`/`updateItemQty`/`previewItemQty` y `createFromSalesOrder` son operaciones sin escritura de kardex: busqué `inventory.record/reverse/recostForward` en los tramos tocados de `sales-orders.service.ts` y `sales-order-edits.service.ts` y no hay. La clasificación es correcta. Su riesgo es de carga, no de recosteo (reservar, crear OP por línea). `createFromSalesOrder` con un pedido grande es el que más puede tardar; medirlo con el de más líneas real.
- `previewItemQty` (cc45) corre el mismo servicio y deshace. Con 30 s tiene el mismo techo que el guardado, coherente.

### E-05 (D-684) y el motor de recosteo

- Misma cuenta que el motor: `averageOutCost` (`recost-engine.ts:199`) devuelve `round4(max(value, 0))` cuando la salida se lleva toda la cantidad, y `replayItem` usa esa función para filas `AVERAGE` de tipo OUT (`:146`). Un replay posterior sobre una de estas salidas da delta 0, así que no escribe ADJUST espurios.
- Salidas viejas que agotaron el ítem con `qty × avg`: el replay propone `averageOutCost` completo, la diferencia es como máximo `qty × 0,0001` y `isRoundingNoise` (`:259`) la absorbe. No hay ADJUST espurios en `recosteo:historico` por esa causa. Es la tolerancia exacta que dejó cc53.
- Si después cambia el valor de una entrada anterior (flete tardío), el replay sí corrige la salida, y está bien.
- Invariante de reservas: `newQty = balance.qty − qty = 0`, mismo valor que antes; `assertReservationInvariant` recibe el mismo argumento. Sin cambio.
- `reverse()` de una salida así (`:913-919`): usa `effectiveCost` del original (total más recosteos), reentra por ese valor y `unitCost = origValue/origQty`. Queda neto cero.
- `input.totalCost` para OUT se rechaza al inicio de `record()` (D-359), así que ningún llamador pasa total explícito en una salida; la rama nueva no puede chocar con eso.
- Rama bien ubicada: va después de la de retrofecha (`atDate?.qty.gt(0)`), por lo que "no retrofechada" se cumple: con `laterCount > 0` y stock a la fecha entra en la primera.

### E-11 (D-685)

- `pepsCorrectedCosts` (`kardex-peps.service.ts:116-142`): suma recosteos a IN y ADJUST con `rowCostOfRecost` (OUT se ignora). Los ADJUST de recosteo no se vuelven movimientos propios (`own = recostOfId === null`), tampoco entran en `inRange` ni en la resolución de documentos. Sin N+1 nuevo.
- Fecha: la fila de recosteo lleva la fecha de la fila original, así que el filtro `<= to` la incluye si y solo si la original entra. Un recosteo cuya original quedó fuera por fecha no puede aparecer, y si una apareciera sin su objetivo, `pepsCorrectedCosts` la descarta (`if (!target ...) continue`).
- Anulaciones: la reversa de una entrada (OUT con `reversalOfId`) sale de su capa al costo de esa capa, así que usa el corregido. La reversa de una salida (IN con `reversalOfId`) devuelve las porciones de capa y no consume su propio `totalCost`, por lo que cualquier recosteo sobre esa fila es inocuo.
- `kardex-sheet.service.ts` reutiliza `KardexPepsService.report`, no recalcula, y el xlsx lee el mismo `PepsResult`. Los DTO ya traen el campo nuevo `recostOfId: null` en el test. Sin cambios necesarios.

### Pruebas

- Las pruebas unitarias nuevas de PEPS cubren el caso de flete tardío y la función pura (pasan).
- La de E-05 es db-spec (no la corrí). Falta una prueba que fije la regla de P1-1 (qué `avg_cost` queda tras agotar el ítem y qué hace el piso de precio).

## Respuesta del autor (cc58)

- **P1 (el promedio queda en 0 y el piso de precio se pierde): corregido.** La salida que agota el
  ítem se lleva el valor exacto, pero el saldo conserva su promedio, como toda salida. La prueba de
  `recost.db-spec.ts` lo fija (`avg: '3.3333'` con cantidad 0).
- **P2 (`mountCoil` a 30 s fijos): corregido.** Vuelve a 30 s + 3 s por bobina extra, como
  excepción con nombre en el centinela.
- **P2 (120 s → 60 s en anular o editar una compra recibida y en el borrador): corregido de otra
  forma.** Quedan en 120 s, como excepciones con nombre: el historial (Fase 2b y SM-1 de cc28)
  muestra que con menos tiempo una compra de 200 líneas no se podía anular. Se le avisa al dueño
  para que lo ratifique (D-683).
- **P2 (comentarios viejos):** corregidos en `close-preview.ts` y `mountCoil`.
- **P3:** la consulta extra de la salida que agota el ítem queda (una por salida que llega a cero);
  la diferencia `unitCost × qty` contra `totalCost` es la misma de las salidas retrofechadas; que
  PEPS cambie meses pasados cuando llega un recosteo va al handoff y al UAT.
