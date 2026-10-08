# cc34 C1 (B1) — autorrevisión

> **Autorrevisión** (subagente que no leyó el handoff de implementación). Es una lista de
> riesgos, **no una aprobación** ni un pase cruzado (AGENTS.md §2.2).

Alcance: `git diff d2b21624..624ac9ab` (un commit, `624ac9ab fix(production): el despunte de cada
bobina sale de sus propios partes (cc34 B1)`). Archivos: `roofing-scrap.ts` (nuevo),
`roofing-production.service.ts` (`closeInTx`), `roofing-scrap.spec.ts`, `inspect-cc34-cli.ts`,
`scripts/inspect-cc34.mjs`, `tsconfig.cli.json`, `package.json`, `e2e/tests/multi-montar-f8s3.spec.ts`.

Corrido: `pnpm --filter @ayr/api exec jest src/production/roofing-scrap.spec.ts` → 15/15 verdes.
Una sonda puntual con `tsx` contra `allocateRoofingScrap` (archivo temporal, borrado) para P2-1.
No corrí E2E, `test:db` ni nada contra base.

## P0 — rompe datos o kardex

Ninguno.

## P1 — defecto funcional

Ninguno.

## P2 — riesgo real menor

### P2-1. El reparto proporcional de un total escrito puede dar una cuota negativa y la suma de los SCRAP pasa al `scrapKg` de la orden

`apps/api/src/production/roofing-scrap.ts:85-103` (`splitProportionally`) y `:138-153` (rama
del total escrito), con el tope de `:190-195`.

`splitProportionally` redondea HALF_UP cada cuota menos la última y le deja el resto a la última.
Con tres o más claves que redondean hacia arriba y una última de peso muy chico, el resto queda
**negativo**. En la rama del total escrito esa cuota negativa entra a `targets`. `scrapKg` la suma (y
baja), pero en el tope `take = min(kg, room)` es negativo, no se coloca, y `overflow += kg − take`
suma 0. Resultado: lo colocado en las bobinas es **mayor** que `scrapKg`.

Comprobado con una sonda: 4 bobinas vivas con 100 kg de saldo cada una, un parte que sacó
1000/1000/1000/0,001 kg, total escrito 3000,006 → `scrapKg = 0.005` y asignaciones
A = B = C = 0,002 (suma **0,006**). En el servicio eso deja salidas SCRAP de 0,006 kg en kardex
contra `production_orders.scrap_kg = 0.005`, `consumeReservationQty(…, 0.005)` y un
`consumedKg` de la orden que no cierra con las salidas. Con dos o tres bobinas no puede pasar (el
resto es múltiplo de 0,001 y mayor que −0,001). Hacen falta 4+ bobinas vivas y una con kilos
reportados ínfimos (posible con D-246: un parte topado en una bobina casi vacía), así que la
probabilidad es baja, pero la consecuencia es una cifra de kardex que no cuadra con la orden.

Propuesta: repartir con redondeo hacia abajo (`ROUND_DOWN`) y dar el resto, que entonces siempre es
≥ 0, a la clave de mayor peso (o por restos mayores); o como mínimo filtrar `targets` con
`kg > 0` antes de sumar `scrapKg`. Añadir un caso al spec con 4 bobinas que compruebe
`Σ allocations.kg == scrapKg`, e idealmente un `assert` al final de `allocateRoofingScrap`
(si la suma de `allocations` no es `scrapKg`, lanzar, como la red de seguridad de
`allocateStripKg`).

### P2-2. La pantalla de planta sigue estimando el despunte con la cuenta global (con compensación entre bobinas)

`apps/web/src/app/(app)/planta/roofing-order-panel.tsx:1510-1545` (`needsCloseReason`,
`estimatedScrapKg`) y `closeBoundsOf` (`:1437-1471`). No se tocó en el diff.

Con dos bobinas y lo declarado por parte, el web calcula `max(Σ declarado, piso) − piso`. El API
ahora no compensa entre bobinas. Escenario: A declara 90/100 y B 120/100. El web muestra
«Despunte estimado: 10 kg» y quizá no pide motivo; el cierre real saca 20 kg de B y puede responder
400 pidiendo motivo. La vista previa (`close-preview.ts`) corre el cierre real, así que el resumen
previo sí muestra 20 kg, y el 400 ya tiene camino de vuelta. Queda un texto en pantalla que
contradice lo que hace el cierre.

Propuesta: o bien el DTO de la orden expone el despunte que daría `allocateRoofingScrap` (calculado
en el API, sin copia en el web), o bien el texto aclara que con varias bobinas el estimado lo da la
vista previa. Decidirlo con el dueño; no es parte de B1 si el alcance era solo API.

### P2-3. El CLI de diagnóstico no ve las órdenes en que la regla vieja dejó despunte 0 y la nueva no

`apps/api/prisma/inspect-cc34-cli.ts:46-48` (`where: { …, scrapKg: { gt: 0 } }`).

El caso de manual que motivó B1 es «un parte de menos en A tapaba el despunte real de B». Si la
compensación dejó la orden en exactamente 0 (A 80/100, B 120/100), la orden cerró con
`scrapKg = 0` y el CLI la excluye, aunque con la regla nueva B tendría 20 kg. El conteo
«con diferencia» y los kilos y soles movidos quedan **subestimados** justo para ese caso.

Propuesta: quitar el filtro `scrapKg > 0` (dejar cerradas ROOFING con 2+ bobinas soltadas por el
cierre) o añadir una segunda pasada para las de `scrapKg = 0` con algún parte declarado. Avisar en
el JSON cuántas se miraron con cada criterio.

### P2-4. El CLI infiere «total escrito» comparando contra la cuenta vieja; un empate se clasifica mal

`apps/api/prisma/inspect-cc34-cli.ts:137-160`.

Si al cerrar se escribió un total igual a lo que daban los partes (`consumedKg == oldByReports`),
el CLI lo trata como «declarado por parte» y le aplica la regla por bobina, que puede dar otro
reparto que el total proporcional. Está declarado como limitación en el encabezado, pero el JSON
no marca los empates. Propuesta: marcar `closeInferredAs: 'AMBIGUO'` cuando hay partes declarados
y el consumo coincide, y calcular los dos repartos para esas órdenes.

## P3 — estilo o menor

### P3-1. `D-539` se cita en el código pero no está registrada

`roofing-scrap.ts:17` y `:21` citan D-539 (parte repartido entre dos bobinas en proporción a lo que
sacó de cada una; sobrante en orden de montaje). En `docs/ARQUITECTURA.md` §0.2 del commit la
última es D-538. Registrarla al cierre, y confirmar que la regla del **parte repartido entre dos
bobinas** fue decisión del dueño y no del agente (regla 16): el brief de B1 no la menciona
explícitamente.

### P3-2. Comentario desactualizado en la vista previa

`apps/api/src/production/close-preview.ts:19` dice que el reparto entre bobinas es
`allocateStripKg`; ahora el despunte lo reparte `allocateRoofingScrap`. Cambiar la referencia.

### P3-3. Mensaje del tope por lo montado con varias bobinas

`roofing-scrap.ts:181-185`. En la rama por parte con varias bobinas, el texto «se declaran
X kg consumidos» usa `reportedKg + Σ excesos por bobina`, que puede no ser lo que planta escribió en
ningún lado (A 90 + B 120 → «220 declarados»). Propuesta: en esa rama, nombrar la bobina cuyo
despunte no entra o decir «el despunte por bobina suma X kg».

### P3-4. `roofingCloseScrap` llamado con `remainingKg: 0` solo para recalcular

`roofing-production.service.ts:2203-2207`. Recalcula `scrapKg` y la razón a partir de
`declaredKg = reportedKg + scrapPlan.scrapKg`; el `remainingKg: new Decimal(0)` es un argumento de
adorno. Funciona (da el mismo `scrapKg`, salvo P2-1), pero hay dos fuentes del mismo número.
Propuesta: usar `scrapPlan.scrapKg` y calcular la razón ahí, o que `allocateRoofingScrap` devuelva
`scrapRatio`.

### P3-5. `reportsOutKg` queda sin uso en producción

`roofing-math.ts:127` solo lo usa ahora `mounted-kg.spec.ts:177-215`. El spec «el piso del cierre
(D-246)» prueba una función que el cierre ya no llama; la regla equivalente vive en
`allocateRoofingScrap` (fallback al teórico, `roofing-scrap.ts:122-128`). Propuesta: borrar
`reportsOutKg` y mover sus casos a `roofing-scrap.spec.ts`, o dejar una nota de que es histórico.

### P3-6. Huecos de test

- El caso de «una bobina con dos filas vivas» (`roofing-scrap.spec.ts:158`) no puede darse en el
  producto: montar rechaza una bobina ya montada en la orden (`roofing-production.service.ts:703`)
  y bajar una con consumo está prohibido (`:866`). El test no está mal, pero no prueba un escenario
  real.
- Falta un caso del total escrito con 2+ bobinas en que **ninguna viva** tiene kilos reportados
  (cae a `liveCoils[0]`, `:152`), y uno con una bobina viva montada sin usar (con la regla vieja
  y montada primero se llevaba el despunte; ahora no).
- Falta la comprobación general `Σ allocations.kg == scrapKg` en todos los casos (ver P2-1).
- El E2E nuevo cubre lo declarado por parte con dos bobinas, la reapertura y el recierre, pero no
  el total escrito con dos bobinas ni el umbral de motivo.

## Verificado sin hallazgos

- **Una sola bobina viva, sin regresión.** Comparado con `d2b21624`: por parte,
  `excess = round(max(Σ (declarado ?? salida) − reportado, 0))` equivale a la vieja
  `max(Σ, reportado)` + `roofingCloseScrap`; con total escrito, el mismo rechazo por debajo de lo
  reportado y el mismo tope por lo montado. El reparto entre filas de una misma bobina sigue en
  orden de montaje, como `allocateStripKg`. Los mensajes de los dos 400 son textualmente los de
  antes. `consumedKg`/`scrapKg` que se graban en la orden dan lo mismo.
- **Sin filas vivas.** `liveCoils` vacío: con despunte > 0 lanza el 400 de lo montado (como
  antes); sin despunte, cierra con 0.
- **Parte sin salida de kardex.** Cuenta su teórico en la primera bobina viva; el piso no baja
  (mismo criterio que `reportsOutKg`).
- **Parte repartido entre dos bobinas.** El exceso (o el defecto) se reparte con
  `splitProportionally` sobre lo que sacó de cada una, con la suma exacta (el delta ya viene con
  3 decimales). En esta rama las cuotas negativas no causan el problema de P2-1: se netean y se toma
  `max(·, 0)` por bobina antes de sumar `scrapKg`.
- **Sin compensación entre bobinas.** La rama por parte con varias bobinas netea solo dentro de cada
  bobina y toma `max(neto, 0)` por bobina, como pide el brief.
- **Tope por saldo y sobrante.** Si `scrapKg ≤ Σ saldos` (comprobado antes de colocar), el sobrante
  siempre entra en las demás bobinas vivas en orden de montaje y las asignaciones suman `scrapKg`
  (fuera del caso de P2-1).
- **Bobina de cada parte = la de su `COIL OUT`.** El servicio arma `outs` con `m.itemId` de las
  salidas vivas (`liveMovements`) `refType PRODUCTION`, `refId` del parte; sin cambio en la consulta.
- **Reserva.** `consumeReservationQty(tx, reservationId, scrapKg)` recibe el mismo `scrapKg` que
  suman las asignaciones (salvo P2-1), antes de las salidas, como antes.
- **Umbral de motivo.** `scrapRatio = scrapKg / (reportado + scrapKg)` sobre el despunte nuevo; con
  varias bobinas el despunte puede ser mayor que antes y pedir motivo más seguido, que es lo que se
  pidió.
- **Bloqueos (regla 17).** El orden no cambia: `lockOrder` (pedido → OP → reserva) al inicio,
  `lockCloseSet` con las bobinas de las filas y los saldos de las que sueltan despunte (subconjunto de
  las filas) antes de la primera salida. El plan se calcula antes del bloqueo de bobinas, igual que
  antes `allocateStripKg`, con datos (filas, partes, salidas) que protege el bloqueo de la OP.
- **Kardex solo por `InventoryService`.** Las salidas siguen siendo `inventory.record` con
  `refType SCRAP`, `refId` de la orden; no hay escritura nueva de movimientos ni saldos.
- **Decimal.** Todo kilo es `Decimal`; no hay `number` en las cuentas.
- **Reapertura.** `reopen` no cambió: revierte cada salida SCRAP viva por id y devuelve a cada fila
  lo de su bobina. Como solo hay una fila por bobina soltada por el cierre (no se puede montar dos
  veces ni bajar con consumo), restar el total por bobina a cada fila es correcto. El E2E nuevo
  comprueba saldos después de reabrir y de volver a cerrar.
- **Vista previa.** `previewPlantClose` corre el `closeInTx` real y lo deshace, así que muestra el
  reparto nuevo sin copia de la cuenta. Las bobinas que reciben despunte están entre las montadas
  que lista.
- **«Ejecutar y cerrar».** El borrador se ejecuta en la misma transacción antes de `closeInTx`;
  las salidas recién escritas entran en `coilOuts`.
- **CLI de solo lectura.** Transacción con `SET TRANSACTION READ ONLY` como primera sentencia,
  `assertExecuteAllowed(false)`, rechaza argumentos, sin `create/update/delete`, sin SQL de
  escritura, conexión por entorno (`runApiCli`), sin credenciales en argv. Toma las filas soltadas
  por el cierre (`releasedAt = closedAt`) y reconstruye el saldo previo sumándole el SCRAP de su
  bobina; con una sola fila por bobina la reconstrucción es exacta. Usa la misma función pura que
  el servicio. Los accesorios son `ROOFING`, así que entran.

## Qué se hizo con cada hallazgo

| Hallazgo | Resolución |
| -------- | ---------- |
| P2-1 | Corregido: `splitProportionally` trunca cada cuota y da el resto a la clave de más peso; red que exige Σ asignaciones = despunte y cuotas positivas. Test con 4 bobinas (falla con el reparto anterior: mutación hecha). |
| P2-2 | Fuera de la pieza: la estimación de la pantalla de planta necesita el consumo por bobina, que el brief deja para el rediseño de «Producir una OP». La vista previa del cierre ya muestra la cifra real, y el 400 pide el motivo si hace falta. Queda en el registro de riesgo. |
| P2-3 | Corregido: el CLI toma todas las cerradas (71), no solo las que tienen despunte. |
| P2-4 | Corregido: si el total escrito coincide con lo declarado, el CLI calcula los dos repartos y marca la orden como ambigua con las dos cifras (`ambiguousTotalWritten`). |
| P3 D-539 | Registrada como provisional al cierre (parte repartido entre dos bobinas y sobrante al pasar el saldo). |
| P3 comentario | Corregido en `close-preview.ts`. |
| P3 mensaje / dos fuentes / `reportsOutKg` | Sin cambio: el mensaje es el de siempre con el total que se pretende sacar; `reportsOutKg` sigue con su spec y lo usa `mounted-kg.spec.ts`. |
| P3 tests | Agregado el total escrito sin nada reportado en las vivas. El E2E no cubre el total escrito con dos bobinas: lo cubren los unitarios. |
