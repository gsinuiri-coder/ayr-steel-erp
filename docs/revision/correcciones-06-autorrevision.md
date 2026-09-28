# Correcciones 06 — AUTORREVISIÓN

> **AUTORREVISIÓN** (AGENTS.md §2, regla 2.1): subagente nuevo que no leyó el handoff ni
> `PROGRESO.md`; juzga el código de `git diff 1e420bc..HEAD` (4 commits, rama
> `feat/correcciones-06`). Es una **lista de riesgos, no una aprobación**, y no reemplaza la
> revisión del segundo modelo ni la del dueño.

Fecha: 2026-09-28.

## Qué se verificó

- Lectura completa de `coil-auto-terminate.ts`, `terminate-zero-coils.ts`, la CLI, el diff de
  `coil-operations`, `cutting`, `dispatches`, `production`, `roofing-production`,
  `opening-date-move`, `document-profitability(.service)`, `sales-by-material(.service)`,
  `sales-margin.service`, `reports.controller` y la sección web de rentabilidad.
- Reversas relacionadas leídas fuera del diff: `revertSplit`, `cancelScrap`,
  `CuttingService.reverse`, `reopenRevertedCoils`, `reverseReport` (drywall), `release`/`releaseCoil`,
  `reverseCloseAdjustment`, guardas de montaje (`findLiveStripAssignments`, montaje de coberturas).
- `pnpm exec jest` completo en `apps/api`: **155 suites, 1934 tests, todo verde**. E2E **no** se
  corrió en esta autorrevisión.
- Orden de operaciones confirmado como correcto: en el cierre de OP drywall y coberturas las
  asignaciones se liberan (`releasedAt`) **antes** de `autoTerminateEmptyCoils`, así que la OP que
  se cierra no se ve a sí misma como «montada»; en coberturas además la reserva de la OP se libera
  antes. En la anulación se leen las asignaciones vivas antes del `updateMany` que las suelta.
- Descartado tras verificar: la hipótesis de que una OP ajena termine una bobina que otra OP
  consumió y luego bloquee su reapertura. Ni drywall ni coberturas permiten montar la misma bobina
  en dos OP vivas (`roofing-production.service.ts:660`, comentario de `production.service.ts` en
  `reverseReport`), y liberar exige `consumedKg = 0`.

## P0

Ninguno.

## P1

### P1-1 — Una reversa que no falla puede dejar la bobina `CLOSED` con saldo > 0 cuando la terminó el lote de la CLI (u otra causa)

- `apps/api/src/coils/coil-operations.service.ts:509-516` (`cancelScrap` → `reopenAutoTerminatedCoils`
  con causa `SCRAP/<movementId>`).
- `apps/api/src/invoicing/dispatches.service.ts:917-975` (`reopenRevertedCoils` solo reabre si el
  último `coils.close` tiene `closedByDispatch`).

Escenario concreto (el más probable, en producción real): antes de D-360 una merma de RF-17 dejó
la bobina X en 0 kg y X quedó «Vigente». Se ejecuta `terminate:zero-coils --execute`: X pasa a
`CLOSED` con `autoTerminated: {kind: 'BATCH'}`. Días después alguien anula esa merma
(`POST /coils/scraps/:id/cancel`): `inventory.reverse` devuelve los kilos, `planAutoReopen` no
encuentra una terminación `SCRAP/<id>` (`touched` vacío) y **no hace nada, ni siquiera anota**.
Resultado: X `CLOSED` con saldo positivo — exactamente el estado que D-170/D-164 dicen que nadie
sabría explicar, fuera de producción y sin la liquidación que exige un cierre con saldo. Lo mismo
pasa con cualquier otra causa distinta (p. ej. merma m1 parcial, luego partido que la deja en 0 →
`SPLIT`; anular m1 devuelve kilos a una madre `CLOSED`; esto último ya existía antes, pero ahora
debería quedar al menos anotado y no queda: `planAutoReopen` solo anota si la causa aparece en el
historial).

Propuesta (requiere decisión del dueño, porque choca con «solo reabre si la auditoría referencia
esa misma operación»): la auditoría ya guarda `zeroedBy.movementId`. Reabrir también cuando la
reversa anula **el movimiento que dejó la bobina en 0** (`zeroedBy.movementId === movimiento
revertido`) sea cual sea `kind` — cubre `BATCH` sin aflojar la regla. Y, como mínimo, cuando una
reversa devuelve kilos a una bobina `CLOSED` cuyo último cierre es automático y no la reabre,
escribir el `coils.auto-reopen-skipped` (hoy solo se escribe si la causa figura en el historial).

### P1-2 — Reabrir una OP cerrada antes de D-360 queda bloqueado después de correr la CLI

- `apps/api/src/production/production.service.ts:1196-1221` y
  `apps/api/src/production/roofing-production.service.ts:2417-2441`.

Escenario: OP-000100 (drywall o coberturas) se cerró antes del deploy y consumió su fleje/bobina
entero; el rollo quedó «Vigente» en 0. La CLI lo termina con causa `BATCH/<lote>`. Reabrir
OP-000100 ahora: `reopenAutoTerminatedCoils` busca `PRODUCTION_ORDER_CLOSE/<orderId>`, no lo
encuentra, el rollo no entra a `reopenedIds` y el bucle lanza «El fleje … ya no está disponible
(CLOSED): no se puede reabrir la orden». Antes de D-360 la reapertura pasaba (no hay movimientos
posteriores al cierre). Contradice «la reversa nunca falla por el estado de la bobina». Hay
salida manual (reabrir la bobina desde `/coils/:id/status`, sin motivo porque no hay ajuste), pero
el operario recibe un 400 que antes no existía.

Propuesta: misma regla que P1-1 — aceptar como «terminación de esta operación» la que tiene
`zeroedBy.refId === orderId` (el último movimiento que la dejó en 0 fue de esta OP: `PRODUCTION`
o `SCRAP` con `refId` de la orden), o bien documentarlo en el runbook de la ventana como paso
manual previo. Decisión del dueño.

### P1-3 — El «neto» de la rentabilidad ignora lo acreditado en líneas fuera del motor

- `apps/api/src/reports/document-profitability.ts:310-322` y `:350-353`.

Toda línea de NC que no es de Coberturas Aluzinc se arma con `emptySum()` (`NO_COST`), así que
`net = total + creditTotal` **no resta su venta**. Escenario: factura de UPVC por S/ 1 000 con
costo de despacho S/ 600; NC de descuento de S/ 100 sin devolución de mercadería (el despacho no se
revierte). Neto mostrado: venta 1 000, costo 600, ganancia 400. Neto real: 900 / 600 / 300. La NC
aparece solo como «sin costo» (−100) en `uncostedSalesPen`. En una NC por **devolución** con
reversa del despacho el resultado sale consistente por otro camino (la línea de factura pasa a
«sin costo aún»), así que el error está en las NC de descuento/bonificación, comunes en la
práctica. El test `nota de crédito: lo acreditado y el neto` fija el comportamiento actual con una
NC de UPVC (`uncostedSalesPen: '-50.0000'`) sin comprobar el neto de esa línea.

Propuesta (decisión del dueño): para una línea de NC fuera del motor cuya línea de pedido sigue
despachada (sin reversa), sumar su venta negativa con costo 0 al acreditado y al neto; o, si no se
quiere inferir, no publicar `net` cuando haya partes de NC sin costear y decirlo en la pantalla.

## P2

1. **Reaperturas sin auditoría rompen la regla del «último cambio de estado».**
   `coil-operations.service.ts:355-358` (`revertSplit` pasa la madre a `OPEN` sin `coils.open`) y
   `cutting.service.ts` (`reverse` la pasa a `IN_THIRD_PARTY`). Ahora el partido y la recepción
   escriben `coils.close` (D-360), así que el último evento auditado dice «terminada» mientras la
   bobina está vigente o en corte. `planAutoReopen` y `reopenRevertedCoils` deciden por ese último
   evento. Propuesta: en `revertSplit` usar `reopenAutoTerminatedCoils` con causa
   `SPLIT/<splitId>` (o escribir el `coils.open`), y dejar un evento equivalente en la reversa de
   la recepción.
2. **Sin lock en la lectura del saldo.** `planAutoTerminate` lee `inventory_balances` sin
   `FOR UPDATE`. En la CLI (`terminate-zero-coils.ts:39-50`) se leen **todas** las vigentes en una
   transacción larga, con la app viva: una reversa concurrente que devuelva kilos entre la lectura
   y el `updateMany` deja la bobina `CLOSED` con saldo. En línea también: el cierre de OP drywall
   solo bloquea con `lockCoil` los flejes con remanente > 0. Propuesta: `SELECT … FOR UPDATE` de
   las bobinas candidatas en orden de id y releer saldos antes del `updateMany`; como mínimo,
   correr la CLI en horario muerto y anotarlo en el runbook.
3. **Sin fila de saldo = 0.** `coil-auto-terminate.ts:112-114`: una bobina sin fila en
   `inventory_balances` (p. ej. de una línea de negocio `NOOP`, donde `record()` devuelve `null`)
   se trataría como vacía y la CLI la terminaría. Propuesta: tratarla como anomalía y listarla.
4. **La CLI imprime una reversa que no corre en producción.** `terminate-zero-coils-cli.ts:130-132`
   omite `--confirm-production`, que `assertExecuteAllowed` exige. Los dry-run (`:82`, `:110`) usan
   el `timeout` por defecto de 5 s de la transacción interactiva, el mismo que ya falló contra Neon
   real en RF-S4b; conviene pasarle un `timeout` explícito.
5. **Comentarios que describen un caso imposible.** `production.service.ts:530`,
   `roofing-production.service.ts:835` y `:2598` dicen «la agotó otra orden mientras esta la tenía
   montada», pero la bobina no se puede montar en dos OP vivas y liberar exige `consumedKg = 0`: el
   disparo en liberar/anular es en la práctica inalcanzable. No es un defecto, pero el comentario
   engaña al próximo lector; mejor decir que es defensivo.
6. **Acciones de auditoría sin etiqueta.** `coils.auto-terminate-skipped` y
   `coils.auto-reopen-skipped` no están en `apps/web/src/lib/audit-labels.ts`; se verán con el
   nombre crudo.
7. **Rentabilidad sobre una nota de crédito.** Si se abre la página de la NC misma,
   `document-profitability.service.ts:46-57` la trata como venta propia: las líneas del motor salen
   con signo negativo y las demás dicen «Sin despacho declarado en este comprobante (D-205)», que
   no aplica a una NC. Propuesta: `notApplicable` con «La rentabilidad de una nota de crédito se ve
   en el comprobante que afecta», o un texto propio.
8. **Despacho mixto con y sin salida.** `document-profitability.ts:241-244`: si parte de los ítems
   del despacho declarado tiene `movement_id` y parte no (D-278), `cost` > 0 y la línea sale
   `COMPLETE` con costo parcial (subestimado). Propuesta: `PARTIAL` con nota cuando
   `withoutMovement` es verdadero y el costo no es 0. Una línea de texto libre despachada sin
   movimiento recibe la nota «antes del inventario inicial», que no es su motivo.
9. **Heredado del motor D-354, no nuevo:** una NC de descuento sobre una línea de Coberturas
   Aluzinc resta costo proporcional a su cantidad como si hubiera vuelto material. La rentabilidad
   lo hereda por diseño (cuadre con «Ventas por material»); anotarlo para cuando se decida P1-3.
10. **Cambio de comportamiento que conviene nombrar en el UAT:** partido y recepción de corte antes
    cerraban con `remaining.lte(0)` sin mirar reservas ni signo; ahora una madre en 0 con reserva
    viva sobre el rollo o con saldo negativo queda `OPEN` (anomalía auditada). Está alineado con la
    regla de D-360, pero en la recepción de corte la madre ahora pasa por `OPEN` antes de
    evaluarse; revisar que el guion UAT lo cubra.

## E2E existentes

Revisados por búsqueda (`status).toBe('OPEN'|'CLOSED')`, reaperturas de OP, D-170, fase3b, fase4-bordes,
cierre-bobina-d164): no encontré aserciones que el cambio rompa aparte de la ya ajustada en
`cierre-bobina-d164.spec.ts`. Madre de corte entero (`fase3b.spec.ts:325`, `:502`) sigue esperando
`CLOSED` y el cambio lo mantiene. **No se corrió la suite**; la suite completa con builds de
producción sigue siendo requisito de cierre.

## Resumen

0 P0, 3 P1 (dos de política de reapertura frente a la terminación por lote, uno de cálculo del neto
con NC), 10 P2. Corregir o decidir los P1 antes del deploy.

---

## Respuesta de la sesión (2026-09-28)

Corregido antes del deploy, con los P1 de la autorrevisión y del segundo modelo juntos:

- **Reversa de lo que dejó la bobina en 0, con otra causa de terminación (autorrevisión P1-1 y P1-2).**
  `reopenAutoTerminatedCoils` reconoce como propia una terminación **automática** cuyo `zeroedBy` es el
  movimiento que la reversa anula (`zeroedBy.movementId`) o su referencia (`zeroedBy.refId`): anular la
  merma pasa el movimiento; reabrir la OP pasa la OP y sus reportes; revertir el partido y la recepción de
  corte pasan el partido y la fila del envío. Cubre la bobina que terminó el lote de la CLI después de
  que esa misma operación la dejara en 0. Un cierre manual nunca se reabre por una reversa. Tests en
  `coil-auto-terminate.spec.ts`.
- **El neto de la nota de crédito en líneas fuera del motor (autorrevisión P1-3).** La línea acreditada que
  no es de Coberturas Aluzinc resta su venta con costo 0 (si hubo devolución, el costo ya volvió por la
  reversa del despacho; si fue descuento, no hay costo que devolver). Una nota de crédito vista por sí misma
  va igual y no consulta despachos. Tests en `document-profitability.spec.ts`.
- **`revertSplit` y la reversa de la recepción de corte sin auditoría (segundo modelo C06-P1-1).** Pasan por
  `reopenAutoTerminatedCoils` (la de corte con `targetStatus: IN_THIRD_PARTY`) y dejan su `coils.open`. Un
  partido anterior a D-360, sin esa auditoría, se reabre como siempre (RF-16).
- **P2 tomados:** el comando de reversa que imprime la CLI lleva `--confirm-production` en producción; los
  dry-run de la CLI con 120 s; los comentarios «la agotó otra orden» describían un caso imposible y ahora
  dicen que es una red de seguridad; etiquetas en la web para `coils.auto-terminate-skipped` y
  `coils.auto-reopen-skipped`; la rentabilidad de la propia nota de crédito ya no dice «sin despacho
  declarado».
- **P2 anotados, sin cambio:** el saldo se lee sin lock en la CLI (se corre en horario muerto, una sola
  transacción); una bobina sin fila de saldo cuenta como 0 (no existe hoy: las 82 vigentes la tienen); un
  despacho mixto con ítems con y sin salida de kardex se costea por lo que tiene salida; el motor de D-354
  resta costo por una nota de crédito de descuento (viene de antes); la unidad del costo por unidad en el
  total; el partido y la recepción de corte ya no terminan la madre en 0 con reserva viva (anomalía,
  auditada: va al guion UAT).

Verificación: unitarios de coils, reports, production, cutting e invoicing 605/605; E2E local de
`fase2b`, `fase3b`, `cierre-bobina-d164` y `correcciones-06` 33/33.
