# cc53, corte A: autorrevisión del recosteo por fecha (D-649, D-650)

> **Autorrevisión (no es pase cruzado).** La hizo un subagente nuevo que no leyó el handoff de
> implementación. Es una lista de riesgos y no aprueba nada. Faltan el pase de un segundo modelo y
> la revisión del dueño (AGENTS.md §2.2).

- Fecha: 2026-10-14
- Alcance: `git diff origin/main...cc53-a-recosteo`, es decir el commit `78d996e8`, 56 archivos.
  No entran los archivos sin commitear del worktree (`recost-historic*`, el cambio en
  `sales-returns.service.ts` y el de `package.json`), salvo donde se cita.
- Método: lectura del código, sin correr nada. Cada escenario se siguió en el código de este
  commit.

## Resumen

| Sev. | Cant. | Tema                                                                                                                                                                                                                                                                                                                   |
| ---- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0   | 0     | —                                                                                                                                                                                                                                                                                                                      |
| P1   | 3     | Guardas de «movimientos posteriores» que ahora ven los `ADJUST` de recosteo y bloquean reversas para siempre; reabrir una bobina se rompe; bloqueos de saldo tardíos sin `NOWAIT` (regla 17)                                                                                                                           |
| P2   | 4     | El motor y el saldo no reproducen igual el stock cuando la cantidad baja de cero a la fecha (salida atrasada mayor que el stock de ese día); devolución parcial con `returnedTotalCost` viejo; plan de NC leído antes del lock; recosteo histórico sin commitear y el primer recosteo arrastra todo el desorden previo |
| P3   | 8     | `production-summary` con recosteo de una reversa, `opMaterialByOrder` ignora el recosteo, `followCost` de un ajuste en la segunda corrida, conteos y paginación del kardex, costos denormalizados viejos, rendimiento, meses pasados, D-285                                                                            |

Hay 3 P1: hay que corregirlos antes del deploy.

---

## P1

### P1-1. Las guardas de «posterior» cuentan el recosteo como un movimiento real, y como un recosteo no se anula, la reversa queda bloqueada para siempre

Un `ADJUST` de recosteo hereda el `refType` y el `refId` de la fila que corrige, y su `id` y su
`at` son posteriores a todo. Varias guardas buscan «un movimiento vivo posterior que no sea IN» y
le piden al usuario que lo anule primero. `reversibleMovement` rechaza anular un recosteo
(`inventory.service.ts:1036-1041`, «no se anula por separado»). Resultado: nadie puede destrabar
la reversa.

- `production.service.ts:945-955` y `roofing-production.service.ts:2616-2626` (revertir un
  reporte). El producto del reporte recibe un recosteo con la cascada (`ADJUST`,
  `refType=PRODUCTION`, `id > entry.id`). Desde entonces el reporte no se puede revertir y el
  mensaje dice: «Las piezas de este reporte ya se movieron (ADJUST PRODUCTION): anula ese
  movimiento».
  - Escenario: una OP con el reporte R del 10-10. Se registra una merma manual de la bobina con
    fecha 10-08 → el `OUT` de R se recostea → el `IN` del producto de R se recostea. Ya no se puede
    revertir R.
- `production.service.ts:1342-1355` y `roofing-production.service.ts:2779-2789` (reabrir una OP
  cerrada). El ajuste de cierre se recostea por la cascada de `SCRAP`, y ese recosteo es un
  `ADJUST` del producto con `id > adjust.id`, así que la OP no se reabre. En la misma rutina, en
  `production.service.ts:1416-1435` y `roofing-production.service.ts:~2846-2862`, cualquier
  recosteo del fleje escrito después del cierre bloquea la reapertura («movimientos posteriores al
  cierre»).
- `cutting.service.ts:530-540` (revertir una recepción de corte). El recosteo del `OUT` de la
  madre tiene `id > motherOut.id`, así que `motherBlocking` siempre lo encuentra.

Propuesta: en estas guardas, excluir `recostOfId: { not: null }`, o mejor tratar el recosteo como
parte de su fila (bloquea solo si su fila bloquea). Además, cuando se anula la fila original, la
reversa ya usa el costo efectivo (`effectiveCost`), así que no hace falta anular el recosteo
aparte. Hay que sumar un db-spec por guarda: recostear y después revertir.

### P1-2. Reabrir una bobina terminada falla, o la reabre sin devolver los kilos liquidados

`coil-operations.service.ts:1015-1030` (`reverseCloseAdjustment`) toma el **último movimiento por
id** de la bobina y solo lo revierte si es el `CLOSE_ADJUSTMENT` del cierre.

- Si el `OUT` de liquidación se recosteó, el último movimiento es su recosteo (mismo `refType`
  `CLOSE_ADJUSTMENT` y mismo `refId` de la bobina, `reversals` vacío). Entonces `reverse()` lo
  intenta anular y da 400: «Un ajuste de recosteo no se anula por separado». La reapertura queda
  bloqueada.
- Si el último es el recosteo de otra fila de la bobina, con otro `refType`, `adjustment` queda
  `undefined` y la función devuelve `null`. El llamador (`:610`, `:667`) igual pone la bobina en
  `OPEN` con el kardex en 0: los kilos que el cierre liquidó no vuelven y no hay error.
- Escenario: un fleje sale de un corte o un partido y se usa en producción hasta terminarse con
  ajuste de cierre. Después entra un movimiento atrasado sobre la madre, de fecha anterior al
  corte. La cascada recostea el `IN` del fleje y todos sus `OUT`, incluida la liquidación.

`coil-auto-terminate.ts:272` (`lastMovementByCoil`) tiene la misma premisa: el último movimiento
es el que dejó la bobina en 0. Hoy casi siempre coincide, porque `createMany` escribe en orden de
reproducción y la última fila corregida suele ser la que dejó el saldo en 0, pero no está
garantizado (ver P3-8).

Propuesta: en las dos lecturas del «último movimiento», ignorar `recostOfId != null`.

### P1-3. `recostForward` toma saldos fuera de orden y sin `NOWAIT` (regla dura 17, D-475)

`inventory.service.ts:442-449` (y `lockBalance` en `:484`) llama a `lockInOrder` **en mitad** de
la operación. Para ese momento ya tiene el saldo del ítem que disparó el recosteo (y, en un
reporte o un cierre, los de toda la operación). `lockInOrder` ordena solo **su** conjunto y
`lockBalance` hace `FOR UPDATE` con espera.

- Las bobinas nuevas sí salen con `NOWAIT`, porque `lockCoilRows` ya ve `balances=true`.
- **Los saldos nuevos no.** Ejemplo: un reporte de la OP del producto P1 ya tiene, en orden, el
  fleje y P1. Su `OUT` atrasado dispara una cascada hacia el producto P2 de otra OP, con
  `PRODUCT:P2 < PRODUCT:P1`, y espera P2 teniendo P1. Otra transacción que tomó P2 y después P1
  (en orden canónico) cierra el ciclo. Postgres lo detecta como deadlock y el usuario recibe un 409. No es corrupción, pero es justo lo que la regla 17 pide convertir en `NOWAIT`.
- La misma lógica aplica cuando la cascada pasa de bobina a bobina: el partido o el corte pasan de
  la madre a las hijas con ids arbitrarios.
- `lock-order.db-spec.ts` no tiene un par nuevo para este camino (regla 17: «un camino nuevo que
  tome documentos o inventario suma su par ahí»).
- Si después de 3 vueltas el conjunto sigue creciendo, el bucle sale con `plan = again` y escribe
  ítems cuyo plan se leyó **antes** de tomar su lock (`:442-459`). El `lockBalance` del bucle de
  escritura los bloquea, pero tarde.

Propuesta:

1. Los saldos que se tomen con otros saldos ya en mano van con `FOR UPDATE NOWAIT` y salen con
   `LockOrderConflict`, igual que las bobinas en `row-locks.ts`.
2. Si después de 3 vueltas el plan sigue creciendo, lanzar 409 o dejar el recosteo pendiente en
   vez de escribir.
3. Sumar el par a `lock-order.db-spec.ts`.

---

## P2

### P2-1. El motor y `stockAtDate`/el saldo cuentan distinto cuando la cantidad baja de cero, y una salida atrasada mayor que el stock de su fecha deforma el costo de las salidas siguientes

`record()` solo compara la cantidad contra el saldo **de hoy** (`inventory.service.ts:276-281`).
Nada impide una salida atrasada mayor que el stock que había a su fecha. En el motor,
`recost-engine.ts:157` (`value = qty.lte(0) ? cost : value.plus(cost)`) y `:161` descartan el
valor cuando la cantidad pasa por ≤ 0.

Escenario, con números:

1. Entra un ingreso de 5 u a S/ 50 (10-01).
2. Se registra **después**, con fecha 10-03, un despacho de 10 u. `stockAtDate` da 5 u y S/ 50,
   así que `averageOutCost` se lleva los S/ 50 y el saldo queda en −5.
3. El 10-05 hubo un ingreso de 10 u a S/ 100, y luego, ya grabada, una salida de 5 u a S/ 50.
4. Al reproducir: el ingreso arranca con `qty=-5`, así que el valor pasa a 100 y la cantidad a 5.
   La salida de 5 u pasa a costar **S/ 100**, el doble del promedio real de S/ 10.

El total se conserva (150 = 150), pero el costo de ventas queda repartido S/ 5/u y S/ 20/u. Ese
reparto llega al margen del mes y al del comprobante.

Pasa lo mismo, en chico, con:

- el residuo de redondeo que dejaron las salidas anteriores a cc53 al llegar a 0 (la suma lineal
  lo conserva y el motor no);
- un `ADJUST` que queda sobre cantidad 0 a la fecha (el siguiente `IN` lo borra en el motor, pero
  sigue en el saldo).

`stockAtDate` (la cuenta lineal, que también escribe el saldo en `:486-489`) y `replayItem` dejan
de coincidir, y una corrida posterior desde antes vuelve a «corregir» contra otra base.

Propuesta (es política, así que pasa por el dueño según la regla 16):

- **(a)** Rechazar una salida atrasada que deja el kardex negativo en alguna fecha, con el mismo
  chequeo de mínimo corrido que `replaceEntry` (`minRunningAfterReplace`). Es lo recomendado.
- **(b)** Que el motor lleve la cantidad negativa con el último promedio, en vez de reiniciar.

En los dos casos, `stockAtDate` y `replayItem` deberían usar la misma cuenta. Falta un caso en
`recost-engine.spec.ts`.

### P2-2. La última devolución parcial toma el costo contra un `returnedTotalCost` viejo

En el commit, `sales-returns.service.ts:140` suma `sales_return_items.totalCost`, que es el costo
**grabado**. En cambio `effectiveOutCost` ya usa el costo efectivo del despacho.
`sales-return-allocation.ts:108-110` calcula la devolución completa como
`totalCost − returnedTotalCost`.

Escenario:

1. Primera devolución de 4 de 10 a S/ 40.
2. La salida se recostea a S/ 150 y el motor lleva la primera devolución a S/ 60.
3. La segunda devolución, por 6, toma 150 − **40** = S/ 110 en vez de S/ 90.

El kardex devuelve S/ 170 sobre S/ 150 despachados, y solo se arregla si una corrida posterior
reproduce esa fila. **En el árbol de trabajo ya hay una corrección sin commitear**: suma el
recosteo de cada `movementId` de devolución. El signo es correcto (`IN`: el ajuste suma). Hay que
commitearla con un test que cubra «dos devoluciones con un recosteo en medio».

### P2-3. El plan de la NC lee el costo efectivo antes de bloquear los saldos (D-474)

`createForCreditNoteInTx` llama a `planForLines`, que lee `effectiveOutCost` y `returnedTotalCost`
(`sales-returns.service.ts:~260`), y recién después llama a `lockInOrder` (`:~276`). Antes de cc53
el costo de un `OUT` era inmutable y esto no importaba. Ahora un recosteo concurrente del mismo
ítem puede confirmarse en esa ventana, y la devolución se graba con el costo anterior. El motor
solo la corrige cuando una corrida futura arranque antes de ella.

Propuesta: volver a calcular el plan (o al menos los costos) después de `lockInOrder`.

### P2-4. El recosteo histórico no está en el commit, y el primer recosteo en línea de cada ítem corrige todo el desorden anterior a cc53

- `recostPending` y la documentación remiten a `pnpm recosteo:historico`. En este commit no están
  el script, la CLI, ni la entrada de `package.json` (están sin commitear en el worktree). Si se
  despliega el commit tal cual, un recosteo pendiente no tiene herramienta para resolverse.
- Las salidas de producción anteriores a cc53 se grabaron al promedio del momento de grabar. El
  primer movimiento atrasado sobre un ítem reproduce todo lo posterior con la regla nueva y escribe
  ajustes por **todo** el desorden histórico (el caso de UPVC6MT de cc52, por ejemplo). Esos
  ajustes quedan atribuidos en la auditoría a una acción chica y sin relación.

Propuesta: el corte A y la herramienta histórica salen juntos, y el histórico corre contra
producción (con el OK de D-460 si escribe masivo) antes, o en la misma ventana, de habilitar el
recosteo en línea. El guion del UAT lo debería decir.

---

## P3

1. **`production-summary.service.ts:50`.** El `OR` deja fuera el recosteo de una fila anulada,
   pero **incluye el recosteo de la fila de anulación**: su `recostOf` no tiene `reversals`. Si la
   merma de una OP se reabre y después se recostea su reversa (`IN`), el despunte de esa OP suma
   un −Δ fantasma. Propuesta: `recostOf: { reversalOfId: null, reversals: { none: {} } }`.
2. **`sales-margin.service.ts:311` (`opMaterialByOrder`).** `ELSE 0` ignora los recosteos de los
   `OUT` de producción. La columna «material de OP» queda con el costo grabado mientras la de costo
   ya está recosteada. Propuesta: `ELSE -m."total_cost"`, como en `coilUsage`.
3. **`recost-engine.ts:105` (`followCost` de la anulación de un ajuste).** Usa
   `row.recorded × corrected / source.effective`. En la **segunda** corrida que corrige el mismo
   ajuste, `source.effective` ya incluye el primer recosteo y `row.recorded` no. Da
   `R1·E3/E2` en vez de `R1·E3/E1`. Propuesta: `row.effective × corrected / source.effective`.
   Solo alcanza a un ajuste de cierre sobrescrito por la cascada de `SCRAP` y anulado.
4. **Conteos.**
   - `assertChronological` (`inventory.service.ts:~605`) cuenta los recosteos en «queda ANTES de N
     movimiento(s)» y en `laterMovementsNote`, mientras `laterMovementCount` los excluye: dos
     números distintos para lo mismo.
   - En el listado mezclado del kardex, `total` incluye los recosteos que la página pliega, así
     que las páginas muestran menos filas de las que dice el total. Un recosteo cuya fila quedó en
     otra página aparece suelto, sin la marca «recosteado».
5. **Costos denormalizados que quedan viejos tras un recosteo:** `production_reports.materialCostPen`
   y `unitCostPen`, `productionOrder.materialCostPen`, `overheadCostPen` y `scrapCostPen`,
   `sales_return_items.totalCost` y el `outValuePen` del corte. Las pantallas de OP y reporte
   muestran el costo grabado y los reportes del kardex el corregido. Hay que documentarlo o
   mostrar las dos cifras.
6. **Rendimiento.**
   - `planRecost` carga **todo** el kardex de cada ítem (`loadItem`, sin límite) antes de comparar
     con el tope de 500, y lo hace al menos dos veces: el plan y el replan bajo lock.
   - Hay una consulta `loadExternal` por cada vuelta de la cola, y `queue.includes` es O(n).
   - Un ítem con miles de filas atrasado unos días carga miles de filas para terminar «pendiente».
   - `lockInOrder` sobre bobinas toma también las bobinas de sus agregados con `NOWAIT`, lo que
     sube la tasa de 409 bajo carga.
   - Las transacciones con el timeout por defecto de 5 s (las que no lo suben) pueden quedarse
     cortas con una cascada contra Neon.
   - Propuesta: medir con log de Prisma un caso real de cascada (bobina → 3 reportes → ventas),
     como pide AGENTS.md §5 («medir antes de afirmar»).
7. **Meses pasados.** No hay cierre formal, así que el recosteo cambia, para meses ya
   presentados, lo siguiente:
   - margen por pedido y por comprobante;
   - venta por material;
   - rentabilidad por documento;
   - reporte mensual de bobinas (`closing_value`);
   - producción y despunte;
   - el kardex promedio.

   Los Excel ya descargados no van a coincidir con un reporte que se baje hoy. El kardex PEPS no
   cambia (lo excluye bien). Está decidido por D-649 («que el costo caiga en su mes»), pero
   conviene que la auditoría «Recosteo por fecha» liste los meses afectados y que el guion UAT lo
   advierta.

8. **D-285 y orden de la cascada.**
   - La herramienta de fecha de la carga inicial (`operation_date` editado con el permiso del
     trigger) no dispara recosteo. Después de moverla, la siguiente corrida que pase por ese ítem
     corrige en bloque.
   - `createMany` (`inventory.service.ts:~480`) escribe los ajustes en el orden de reproducción y
     con el mismo `at`. Lo que lee «el último por id» (P1-2) depende de ese orden implícito.

---

## Lo que se verificó y está bien

- **Puertas (regla 8).** Solo `InventoryService` escribe. `recostForward` hace `createMany` de
  `ADJUST`, no edita filas y escribe el saldo con `writeBalance`. `inventory-recost.ts` solo lee.
  La migración agrega una columna anulable, la FK `RESTRICT` y el `CHECK` de que solo un `ADJUST`
  lleva `recost_of_id`. No toca el trigger append-only.
- **Cascada.** La reproducción de un ítem se recalcula entera desde `start`, con los costos
  efectivos antes de esa posición. El override es `recorded + parte(Σ (corregido − grabado) de las
fuentes)`, acumulado contra lo grabado, así que reprocesar un ítem no cuenta dos veces. Termina
  porque lo fabricado es otro ítem y no hay ciclos. `refId` coincide entre `OUT` e `IN` en
  producción (reporte), partido, corte y `SCRAP` con el ajuste de cierre (la OP).
- **Signos.** El recosteo de una venta (`OUT`) es −Δ en el saldo y +Δ en el costo (`ELSE -total`).
  El de la reversa `IN` es +Δ y resta costo. La rama `RETURN` de `sales-margin` (`OUT → +`,
  resto `−`) da bien el `IN` de devolución, su reversa y sus recosteos. `coilUsage` y el
  `closing_value` mensual incluyen el recosteo con el signo correcto. En `production-summary`, el
  `ADJUST` negado es correcto para el recosteo de un `OUT` de bobina (fuera del caso P3-1).
- **COALESCE de la línea.** `COALESCE(reversal_of_id, (target.reversal_of_id), recost_of_id, id)`
  ata bien el recosteo de una salida y el de su reversa a la línea del despacho y de la devolución.
  El subselect va por PK.
- **Reversas.** `reverse()` toma el costo efectivo del original. El motor sigue el corregido del
  original (`REVERSAL`) y una devolución por cantidad (`RETURN`).
- **Saldo.** Después de recostear, el saldo se escribe desde el kardex (suma lineal) para cada
  ítem ajustado con cantidad > 0. En la ruta normal (fecha de hoy) no hay consultas extra
  (`laterMovementCount` corta antes).
- **Sobras de D-648.** No queda `acceptBackdatedCost` ni `BACKDATE_COST_MISMATCH` en API, web ni
  E2E. La etiqueta de auditoría histórica se conserva, como corresponde.

**Corregir los 3 P1 antes del deploy. Los P2-1 y P2-4 necesitan una decisión del dueño o una
coordinación de deploy.**
