# cc53 corte B — revisión de segundo modelo (posterior al deploy)

Revisor: segundo modelo (Sonnet, contexto limpio). Solo lectura sobre `docs/cierre-cc53` = `origin/main`
7fd1a24b. **Revisión posterior al deploy**: los tres diffs ya estaban mergeados en `main`. No vale como
aprobación: cierra el dueño (AGENTS.md §2.2.3). No se corrió ninguna suite ni se tocó ninguna base;
todo es lectura de código.

Alcance:

1. D-652 (`1a4db167..32eb00f9`): `recost-engine.ts` (`fitsWithoutNegative`, `firstValidDate`),
   `inventory-recost.ts` (`qtyRowsOf`), `inventory.service.ts` (`assertNoNegativeAtDate`, `record`,
   `reverse` con `{ reentry }`), `coil-operations.service.ts`.
2. Hotfix de topes (`32eb00f9..7755b6f4`): `KARDEX_TX_OPTIONS` y su centinela.
3. Corte B (`7755b6f4..7fd1a24b`): `recost-historic-cli.ts`, `recost-historic.ts`, `inspect-cc53-cli.ts`,
   wrappers y `package.json`.

Veredicto: **sin P0. Sin P1.** Cuatro P2 y cuatro P3, abajo. Los P2 son de robustez o de la regla de
comparación, no corrompen datos.

---

## 1. D-652

Cómo funciona (verificado): `record` OUT con fecha atrasada y filas posteriores → `assertNoNegativeAtDate`;
`reverse` de una IN con fecha atrasada y filas posteriores → lo mismo con la cantidad original;
`qtyRowsOf` toma el kardex del ítem en orden (`operationDate, at, id`), sin recosteos (los pliega
`foldRecosts`), y cancela los pares original+reversa del mismo día.

### Lo que está bien (comprobado por lectura)

- `fitsWithoutNegative` evalúa el saldo de **fin de día** de la fecha, inserta la salida después de todas
  las filas de ese día (coherente con que la fila nueva tiene el id mayor) y exige `corriente − qty ≥ 0`
  en cada punto posterior. Es el criterio de D-374.
- `firstValidDate` prueba `date`, cada fecha con movimientos entre `date` y hoy, y hoy. El primer día en
  que cabe siempre es una de esas fechas (el saldo solo cambia en fechas con movimientos), así que la
  sugerencia es correcta y mínima. `null` solo si ni hoy alcanza.
- Falsos positivos revisados, sin hallazgo:
  - **Despacho a la fecha del comprobante y re-fechado (D-288):** la reversa se hace a la fecha del
    original (`dispatches.service.ts` ~L810) y es de una OUT, que no se chequea; el par queda
    cancelado en `qtyRowsOf`, así que el OUT nuevo no ve el hueco. Correcto.
  - **Re-fechado con fecha explícita (`mode.operationDate`):** la reversa de OUT no se chequea. OK.
  - **Recosteo de bobina (D-045):** `reentry: true` salta el chequeo y el `recostForward` intermedios;
    el reingreso (`record` IN, `laterCount > 0`) recostea. Reversa y reingreso quedan como par del mismo
    día y se cancelan en `qtyRowsOf`. OK.
  - **`replaceEntry` / edición de compra recibida (misma línea):** no pasa por `reverse` ni por `record`;
    no le aplica D-652. Su estado final ya lo juzga. OK. El camino de «cambio de producto» sí usa
    `reverse` IN con fecha `date`: aplica D-652, que es lo correcto.
  - **Corrección de fecha recibida** (`purchase-received-date-fix.ts`): graba la IN nueva y después
    reversa la vieja a su fecha vieja. Si la fecha se mueve **hacia atrás**, la IN nueva cubre y pasa. Si
    se mueve **hacia adelante** más allá de una salida que dependía de la IN vieja, la reversa se rechaza
    con `BACKDATE_NEGATIVE_STOCK`: es el resultado correcto, pero el mensaje habla de «La anulación del …»
    y no de la corrección de fecha (P3-3).
  - **Devoluciones:** la IN de devolución no se chequea; su anulación (reversa de IN) sí, con la fecha que
    se le pase; con fecha de hoy `laterCount = 0` y vale el chequeo de saldo de siempre.
  - **Producción / corte / partido:** las OUT y las reversas de IN usan `operationDate` (por defecto
    hoy → cero consultas). Con fecha atrasada se rechazan solo si de verdad dejan un día en negativo.
  - **D-285 (mover fecha de la carga inicial):** no pasa por `record`/`reverse`; D-652 no se aplica. Por
    construcción puede crear negativos históricos (mover la IN hacia adelante), pero eso no es regresión
    de este diff, y `inspect:cc53` los lista.
- **No retroactividad:** la excepción `before.lt(0)` hace que un punto ya negativo no bloquee. Es
  coherente con el criterio declarado en AGENTS.md. Ver P3-1 sobre su alcance real.

### Hallazgos

**P2-1 — `inventory.service.ts` (`record`/`reverse`): el chequeo corre después de `assertChronological`, en dos pasos.**
`assertChronological` lanza `BACKDATE_OUT_OF_ORDER` (diálogo de «confirmar retrofecha») y solo tras
confirmar aparece `BACKDATE_NEGATIVE_STOCK`. El usuario confirma una retrofecha y luego choca con un
rechazo duro que podía haberse visto antes. No hay pérdida de datos, pero es UX confusa y un viaje de
ida y vuelta de más. Corrección: evaluar D-652 antes (o dentro) del acuse de retrofecha, o decirle al
diálogo cuando la fecha elegida no cabe.

**P2-2 — dos implementaciones de «primera fecha válida».** `invoice-dispatch-plan.ts` (plan del despacho
a la fecha del comprobante, con su propio `firstValidDate` y `BACKDATE_NEGATIVE_STOCK` en
`packages/shared/src/schemas/invoicing.ts`) y el nuevo `recost-engine.ts` calculan lo mismo con
fuentes distintas. La web solo entiende el del plan (`dispatch-at-issue-date.tsx`). Si divergen (por
ejemplo, el plan no cancela pares del mismo día o cuenta reservas), `record` rechazaría con otra fecha
sugerida que el plan aceptó. Sugerencia: que el plan use `qtyRowsOf` + `firstValidDate`, o un test que
fije que ambos coinciden sobre los mismos datos.

**P2-3 — la web no consume `BACKDATE_NEGATIVE_STOCK` fuera del despacho del comprobante.** `grep` en
`apps/web/src` no encuentra el código. Producción, corte, reversas de despacho/producción, anulaciones
y el cambio de producto de una compra reciben un 400 con `message` (legible, con la fecha), pero
`firstValidDate` no se usa para reintentar. Es aceptable (el mensaje ya dice la fecha), solo queda
anotado: el texto es hoy toda la ayuda.

**P2-4 — costo de consultas.** Cada OUT/reversa de IN atrasada con filas posteriores carga el kardex
completo del ítem por `loadItem` (incluye `salesReturnItem` para devoluciones) solo para leer
cantidades. Para un SKU con miles de filas es una lectura grande dentro de una transacción que ya
tiene el saldo bloqueado. Lo cubre el tope de 30 s, pero no hay presupuesto de consultas por test
(regla del AGENTS.md §6). Una consulta agregada de `(operationDate, type, qty)` ahorraría el resto.

**P3-1 — el «no retroactivo» permite empeorar un negativo existente.** La excepción exime a todo punto
que ya está bajo cero, aunque la salida nueva lo profundice. El comentario del test dice «no lo empeora
en otro punto», pero en `legacy` la salida del 08/03 baja el día 05 de −2 a −7. Si la intención es solo
no bloquear por la deuda vieja, vale; si es no empeorarla, la regla correcta sería `corriente − qty ≥
min(corriente_original_en_ese_punto, 0)` o equivalente. Decisión de política: avisar al dueño.

**P3-2 — `inspect:cc53` no usa el mismo criterio que `qtyRowsOf`.** Recorre fila a fila (no a fin de
día) y no cancela pares del mismo día: puede listar tramos negativos intradía que D-652 no considera
negativos (por ejemplo, reversa registrada antes que su original por `at`). Sobrerreporta, nunca
subreporta. Para una lista de tramos «reales» conviene agrupar por fecha como el motor.

**P3-3 — mensaje.** `assertNoNegativeAtDate(…, 'La anulación')` aparece también cuando lo que se hace es la
corrección de fecha recibida o el cambio de producto de una compra; el texto no lo dice.

**P3-4 — arreglo menor del spec.** `qtyRowsOf` queda sin un test unitario propio del cancelado de pares
(solo lo ejercita `recost.db-spec.ts`). Un caso puro (par mismo día cancelado / distinto día no) lo
fijaría sin base de datos.

---

## 2. Hotfix de topes

- `KARDEX_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 }` aplicado a `registerManual`, `annulExternal`,
  `registerScrap`, `cancelScrap`, `cancel` (bobina) y `releaseCoil`. Verificado en el diff.
- Barrido propio (AST sobre `apps/api/src`, transacciones interactivas **sin opciones** que pasan `tx` a
  otras funciones): las que quedan en 5 s son `catalog`, `coil-film`, `customers`, `cash-sessions`,
  `receivables.reversePayment`, `purchases.reversePayment`, `production.create/consume/release/cancel`,
  `roofing.cancel/updatePlan/setPriority`, `cutting.cancel`, `sales-orders.cancel/releaseReservation/
releaseTemporary/setPromisedDeliveryDate`, `invoicing.createCreditNote/discardDraft/issueDispatchNote`,
  `pos.voidSale` (dos). Ninguna llama a `inventory.record/reverse/adjustCost/replaceEntry/recostForward`
  ni a una `…InTx` de devolución/despacho; las que tocan inventario solo toman bloqueos (`lockInOrder`)
  o reponen reservas. `pos.voidSale` llega al kardex por `dispatches.reverse`, que tiene su propia
  transacción con tope. **No encontré ninguna transacción de kardex/devolución/recosteo con 5 s.**
- **P2-5 — límite del centinela.** `transaction-options.sentinel.spec.ts` solo detecta llamadas con la
  forma literal `this.inventory.(record|…)`, `this.salesReturns.*InTx` y `this.dispatches.*InTx`.
  Una transacción que llegue al kardex por una función auxiliar (`autoTerminateEmptyCoils`,
  `reopenAutoTerminatedCoils`, helpers de `coil-restore`, `purchase-received-*`) o por otro alias
  (`inventory` inyectado con otro nombre) no se detecta. Hoy no hay caso así (comprobado arriba), pero
  el centinela da más seguridad de la que tiene. Mejora barata: sumar a la regex las funciones
  auxiliares conocidas, o detectar `inventory.` sin `this.`.
- Nota menor: la `autoTerminateEmptyCoils` solo cierra bobinas vacías; no genera movimiento. OK.

---

## 3. Corte B (`pnpm recosteo:historico`, `pnpm inspect:cc53`)

- **Dry-run revierte de verdad:** todo ocurre dentro de `db.$transaction(async tx => …)`; en dry-run se
  lanza `DryRun` al final, que fuerza el rollback, y `catch` rescata solo esa instancia. `recostForward`
  y la auditoría (`audit.write(tx, …)`) usan `tx`; no vi escritura fuera de la transacción. Los servicios
  de reportes se construyen con `tx` casteado a `PrismaService`; leen. Correcto.
- **`--execute` gateado:** (1) `assertExecuteAllowed` exige rama declarada por el wrapper (`runApiCli`);
  (2) `run-api-cli.mjs` exige `--confirm-production` contra `production`, incluso en dry-run;
  (3) argumentos desconocidos fallan (`assertArgs`); (4) SKU validado con regex. El OK del dueño por
  nombre (AGENTS.md §3 reglas 3 y 5) es una norma, no un candado de código: nada impide correr
  `--execute --confirm-production` con el comando en la mano, igual que en las demás CLI.
- **Credenciales:** no se imprimen. Los errores salen como `error.message`. Un error de Prisma de
  conexión podría traer el host en texto, no la contraseña. Nada va por `argv`.
- **P2-6 (relevante) — la comparación «al céntimo» no es un candado.** `comparePreviews` corre
  **después** del commit (no puede impedirlo), y solo si existe el JSON del dry-run; si no existe, la
  ejecución sigue en silencio sin ninguna advertencia de que no hubo vista previa que comparar. Además:
  - compara solo valores _posteriores_ (`costAfter`, margen/inventario después, costo de venta por mes);
    no compara `adjustments`, `rowsReplayed`, los valores «antes» ni el conjunto de comprobantes (sí
    detecta uno que aparezca o falte, vía el mapa de claves);
  - un dry-run viejo contra una base que siguió operando (producción vende todos los días) dará
    diferencias legítimas y no distingue entre «cambió la base» y «cambió el motor».
    Recomendación: antes de `transaction` en `--execute`, exigir que exista la vista previa de esa rama y
    que se haya generado con el mismo `git-sha` y hace menos de N horas; si no, abortar. Y, si se quiere
    un candado real, comparar dentro de la misma transacción antes del commit y lanzar para revertir.
- **P2-7 / operativo — bloqueos largos.** La transacción tiene `timeout: 600_000` y toma el conjunto de
  ítems con `lockInOrder` (por D-471). En producción eso bloquea ventas/despachos de esos SKU durante la
  corrida (el dry-run también, porque el rollback ocurre al final). Correrlo en horario muerto y
  avisar; no es un bug del código, es una nota de ejecución.
- **`inspect:cc53`:** lectura real (`SET TRANSACTION READ ONLY`, sin execute). Con `assertExecuteAllowed(false)`
  contra production también exige `--confirm-production`. Ver P3-2 sobre el criterio.
- `monthlyDeltas`: la regla de signo (`OUT` suma, `IN` resta) y el reparto `SALE`/`SALES_RETURN` frente a
  «otros» es razonable; los tests puros existen (`recost-historic.spec.ts`).

---

## Resumen

| Sev | N   | Ítems                                                                                                                                                                                                                    |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0  | 0   | —                                                                                                                                                                                                                        |
| P1  | 0   | —                                                                                                                                                                                                                        |
| P2  | 7   | UX de doble paso (P2-1), dos «primera fecha» (P2-2), web sin código nuevo (P2-3), costo de lectura (P2-4), límite del centinela (P2-5), comparación del corte B no es candado (P2-6), bloqueos largos al ejecutar (P2-7) |
| P3  | 4   | negativo existente se profundiza (P3-1), criterio de `inspect:cc53` (P3-2), mensaje (P3-3), test de `qtyRowsOf` (P3-4)                                                                                                   |

No encontré falsos positivos de D-652 en los caminos reales pedidos (despacho a fecha del comprobante,
re-fechado, partido, corte, producción, devoluciones, anulación/edición de compras, replaceEntry, recosteo
de bobina). La sugerencia de fecha es correcta. El hotfix no deja ninguna transacción de kardex en 5 s.
El dry-run revierte. El mayor riesgo residual es P2-6: la corrida real puede ejecutarse sin vista previa.
