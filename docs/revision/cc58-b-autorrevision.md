# cc58-b — autorrevisión (lista de riesgos, no aprobación)

> **Autorrevisión.** La hizo un subagente nuevo que no leyó el handoff de implementación de cc58.
> No vale como pase cruzado ni como aprobación: es una lista de riesgos para el segundo modelo y
> para el dueño (AGENTS.md §2, regla 2.1).

- Diff: `git diff cc58-a..cc58-b` (17 archivos; casi todo el volumen de `invoicing.service.ts`,
  `production.service.ts`, `roofing-production.service.ts` y `sales-orders.service.ts` es
  reindentado de Prettier al pasar la opción en línea; con `git diff -w` quedan solo los cambios de tope).
- Pruebas corridas (solo unitarias): `transaction-options.sentinel.spec.ts`,
  `kardex-peps.service.spec.ts`, `kardex-sheet.service.spec.ts` e `inventory.service.spec.ts`:
  4 suites, 67 pasan. No se corrió ningún db-spec ni E2E.
- No se midió nada contra Neon: los riesgos de tiempo son de lectura de código y de la historia
  del repo, no medidos.

---

## P1

### P1-1. E-05 deja el promedio en 0 al agotar el ítem, y con eso desaparece el piso de precio de un producto agotado

`apps/api/src/inventory/inventory.service.ts:309-319` (rama nueva `qty.gte(balance.qty)`) escribe
`newAvgCost = 0`. Antes, la salida normal que dejaba el ítem en cero **conservaba** el promedio
(`newAvgCost = balance.avgCost`, rama `else`). Es el camino más común para llegar a cero (vender o
despachar todo el saldo), así que este cambio de comportamiento alcanza a casi todos los ítems
agotados de aquí en adelante. Es un efecto que E-05 no buscaba.

Quién lee `inventory_balances.avg_cost` sin mirar la cantidad:

- **Piso de precio (D-163)**, `apps/api/src/sales/price-floor.ts:383-390`: para un candidato
  `PRODUCT` (y `COIL`, 393-399) toma `balance.avgCost` aunque `qty` sea 0. Con promedio 0, la
  línea queda «sin costo, sin piso» (`NO_COST`). Escenario: un SKU de reventa (UPVC, accesorio,
  drywall en stock) se vende hasta agotarse → la cotización siguiente de ese SKU, mientras no
  entre una compra, ya no tiene piso. El vendedor puede cotizar por debajo del costo sin aviso.
  Pasa igual en el panel de stock del pedido (`sales-orders.service.ts:4229`), en la carga de
  precios (`price-list-import.service.ts:192`, justo lo que endureció D-682) y en el catálogo
  (`catalog.service.ts:732`). Las cotizaciones sin stock son un caso normal (D-188).
- Reporte «Ventas por material», `apps/api/src/reports/sales-by-material.service.ts:704`
  (`NULLIF(ib.avg_cost, 0)`): una bobina consumida entera pasa a mostrar «—» en vez de su último
  promedio. Solo afecta lo que se ve.
- Detalle y PDF de bobina (`coils.service.ts:633/678`, `coil-pdf.ts:122`): una bobina terminada
  muestra «Costo promedio: S/ 0/kg».

Recomendación (la decide el dueño): o E-05 conserva `balance.avgCost` como promedio informativo con
saldo 0 (la cuenta del valor no lo usa: `stockAfterIn` reinicia el valor cuando la cantidad es ≤ 0),
o el piso pasa a buscar el costo de otra fuente cuando no hay saldo. Hoy ya conviven las dos
convenciones: `reverse()` y la salida retrofechada ponen 0, la salida normal conservaba el
promedio. Hay que elegir una y fijarla con una prueba en `price-floor*.spec.ts`
(`price-floor-drywall.spec.ts:230,273` ya usa saldos `qty 0` con promedio distinto de 0).

### P1-2. Anular o editar una compra recibida baja de 120 s a 60 s, y la historia del repo dice que con poco margen no alcanzaba

`apps/api/src/purchases/purchases.service.ts:978` (`cancel`) y
`apps/api/src/purchases/purchase-received-edit.service.ts:232` (`commit`) pasan de
`{ timeout: 120_000 }` a `RECOST_TX_OPTIONS` (60 s). El propio comentario que queda arriba
(`purchases.service.ts:975-977`) dice que con 30 s «una anulación grande se quedaba sin tiempo,
hacía rollback y la compra no se podía anular nunca», y `docs/PROGRESO.md` (Fase 2b) cuenta que se
subió a 120 s por las hasta 200 reversas. Cada `reverse()` hace unas 12 a 15 consultas en serie
(`inventory.service.ts:845-990`: peek, bloqueos, `reversibleMovement`, `laterMovementCount` dos
veces, `effectiveCost`, `assertReservationInvariant`, `writeBalance`, `assertRawMaterialInvariant`
si es bobina, `createMovement`) y además puede recostear. Con 200 líneas son unos 3 000 viajes:
con 20 ms de RTT a Neon ya son 60 s. El tope de 60 s es decisión del dueño (D-683), pero el corte
no trae ninguna medida que muestre que una compra de 200 líneas entra en 60 s.

Escenario: compra recibida grande (200 líneas) → «Anular» → P2028 a los 60 s → rollback → la
compra queda imposible de anular desde la UI. Es el incidente que el comentario describe.
Recomendación: medir antes del deploy (compra sintética de 200 líneas contra la rama `dev`, que es
Neon real), o llevar `cancel` y `commit` a la lista con nombre del centinela con su motivo.

---

## P2

### P2-1. El borrador de producción y su vista previa bajan de 120 s a 60 s

`apps/api/src/production/roofing-drafts.service.ts:218` (`commit`) y
`apps/api/src/production/close-preview.ts:44` (`COMMIT_PREVIEW_TIMEOUT_MS`). El comentario de
`close-preview.ts:36-42` recuerda SM-1 de cc28: «un borrador grande que el cierre real sí ejecuta
fallaba […] con un 500». El borrador ejecuta N reportes y, si cierra, el cierre con recosteo
(D-665). Pasa lo mismo que en P1-2: el tope bajó a la mitad sin una medida. El riesgo es menor
porque el cierre solo ya tenía 60 s.

### P2-2. Operaciones de muchas líneas bajan de 60 s (o de 30 s + 3 s por bobina) a 30 s, sin medida

`git diff -w` muestra estos cambios:

| Lugar                                                                                         | Antes              | Ahora | Trabajo en la transacción                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sales-orders.service.ts:767` (confirmar pedido)                                              | 60 s               | 30 s  | hasta `MAX_SALES_ITEMS` = 50 líneas: un bloqueo por línea, una OP por línea a fabricar, invariantes de reserva y de materia prima; el comentario de 764-766 justifica los 60 s |
| `roofing-production.service.ts:2064` (generar todas las OP de un pedido)                      | 60 s               | 30 s  | una OP y su reserva por línea (D-148)                                                                                                                                          |
| `roofing-production.service.ts:867` (`mountCoil`)                                             | 30 s + 3 s × (n−1) | 30 s  | hasta `MAX_ORDER_STRIPS` = 20 bobinas, unas 12 consultas por bobina, más `reopenInTx` y el sobrante (kardex) por cada bobina que se reabre, más `findRawMaterialShortfalls`    |
| `sales-order-edits.service.ts:743/776/828` (agregar ítems, cambiar cantidad, su vista previa) | 60 s               | 30 s  | reservan y pueden crear OP                                                                                                                                                     |
| `sales-orders.service.ts:2997/3139` (restaurar y completar reserva)                           | 60 s               | 30 s  | bloqueos por línea                                                                                                                                                             |

Nada de esto escribe datos a medias (el rollback es total), pero un pedido grande que no se puede
confirmar o un montaje de 20 bobinas que da 500 bloquean la operación del día. No hay presupuesto
de consultas con prueba para ninguno (no aparece en `stock-panel-batch.spec.ts` ni en otros).
Recomendación: contar las consultas de confirmar un pedido de 50 líneas y de montar 20 bobinas
(log de Prisma, como en cc19) y multiplicarlas por el RTT de Cloud Run a Neon antes de dar por
buenos los 30 s. El comentario de `roofing-production.service.ts:866` («el presupuesto crece con
ellas») quedó desactualizado.

### P2-3. E-05 mete en el costo de venta, sin aviso, cualquier diferencia entre el saldo guardado y el kardex

`inventory.service.ts:315-316`: `totalCost = averageOutCost(kardex, qty)` toma el **valor del
kardex** reproducido por el motor, no `qty × avgCost`. Si el saldo y el kardex coinciden salvo el
redondeo del promedio, la diferencia es de céntimos (lo que buscaba E-05). Pero si un ítem tiene
una diferencia real —justo lo que lista `check:balances` (`apps/api/prisma/check-balances-cli.ts`,
cc57) por encima de `max(0,01; qty × 0,00005)`—, la primera salida que lo agota se lleva esa
diferencia como costo de venta. Después de eso los dos lados quedan en 0, `check:balances` deja de
listar el ítem y la evidencia se pierde.

Hay además dos casos raros que la rama no cubre:

- `kardex.qty` distinta de `balance.qty`. Si el kardex tiene más, `averageOutCost` cobra solo la
  parte proporcional y el saldo igual se pone en promedio 0.
- `kardex.qty ≤ 0` con saldo guardado positivo: la salida queda a costo **0**.

Recomendación: correr `pnpm check:balances` contra producción antes del deploy y anotar el
resultado. Si la diferencia entre `kardex.value` y `balance.qty × balance.avgCost` supera esa
tolerancia, registrarlo en la auditoría del movimiento (o rechazar), en vez de absorberlo en
silencio.

---

## P3

### P3-1. La vista previa del cierre de bobina muestra un costo distinto del que se graba

`coil-close-math.ts:85-93` arma `totalCostPen = qtyKg × avgCostPen` para mostrar la merma
(`SHORTAGE`) que se va con el cierre. La salida real que agota la bobina ahora graba el valor del
kardex. Pueden diferir en céntimos entre lo que la pantalla avisa y lo grabado. Pasa lo mismo con
el costo que el plan de `invoice-dispatch` muestra por ítem (`invoice-dispatch.service.ts:802`).

### P3-2. El costo de cada salida que agota un ítem crece con la historia del ítem

Cada salida que agota un ítem llama a `stockUpToDate(…, KARDEX_END)` → `loadItem`, que lee **todo**
el kardex del ítem con sus recosteos y, si hay devoluciones, una consulta más
(`inventory-recost.ts:157-189`). En una bobina no pesa. En un SKU de producto con meses de
movimientos, un despacho de 50 líneas que agota 50 SKU son 50 lecturas de historia completa dentro
de los 30 s. Hoy no preocupa (datos desde 2026-09), pero el costo crece con el tiempo.

### P3-3. PEPS: un período ya cerrado cambia de forma retroactiva

`kardex-peps.service.ts:181-190`: el recosteo se fecha con la fecha de la fila que corrige
(`inventory.service.ts:528`), así que un flete que llega tarde o el cierre de una OP cambian las capas, y con
ellas el formato 13.1, de un mes ya declarado. Esto parece ser lo que D-685 quiere, pero conviene
que el dueño lo sepa porque toca un reporte para SUNAT. Al revés no pasa: el filtro
`operationDate ≤ to` no deja fuera un recosteo de una entrada del rango, porque lleva la misma fecha.

### P3-4. PEPS: devoluciones, anulaciones y entradas anuladas

Revisado y sin defecto encontrado; queda anotado para el segundo modelo:

- El recosteo de una entrada que anula una salida (`IN` con `reversalOfId`) se suma en
  `pepsCorrectedCosts` pero `valuePeps` lo ignora, porque devuelve las porciones de la salida
  original (`kardex-peps.ts:220-238`). Es lo correcto.
- La anulación de una entrada recosteada (`OUT` con `reversalOfId`) sale de la capa de esa entrada
  al costo corregido. Su propio recosteo se descarta (`target.type === 'OUT'`). Es lo correcto.
- Una devolución de venta (`IN` sin `reversalOfId`) abre capa al costo corregido, porque también
  se recostea con su salida (D-649).
- Falta una prueba de una entrada **anulada** que tenía recosteos, con la anulación dentro del
  rango.

### P3-5. Comentarios desactualizados

- `kardex-peps.service.ts:109-119`: el JSDoc de la clase («D-279 — Kardex PEPS…, presupuesto de
  consultas fijo») quedó encima de `pepsCorrectedCosts`, pegado a otro JSDoc. La clase quedó sin
  documentar y la función con dos bloques.
- `roofing-production.service.ts:866` (ver P2-2).
- `purchase-received-edit.service.ts:231` («el mismo margen que `cancel`») sigue siendo cierto,
  pero ahora el margen es 60 s.

### P3-6. Centinela

- `transaction-options.sentinel.spec.ts:29`: `timeoutMs` ahora cuenta el **mayor** de los dos topes
  de la vista previa. Antes contaba el menor, a propósito, para la prueba del piso de 30 s. Hoy da
  igual porque la prueba nueva fija los dos en 60 s; si alguno vuelve a separarse, el piso tiene
  que mirar el menor y el techo el mayor.
- Hay caminos del día que pueden recostear hasta 500 filas en cascada y siguen en 30 s: despacho
  retrofechado, NC con devolución, cambio de costo de bobina (`coil-operations.service.ts:1342`) y
  recepción de corte. No es una regresión (ya estaban en 30 s), pero la lista `RECOST_PATHS` no
  describe todo lo que recostea, sino lo que el dueño decidió que tenga 60 s.

### P3-7. Lo que no cambia (comprobado)

- `coil-auto-terminate.ts` y `terminate-zero-coils.ts` solo miran la cantidad (`qty` exactamente
  0), no el valor: E-05 no los afecta.
- `reverse()` de una salida que agotó el ítem reingresa su costo efectivo (`effectiveCost`), con lo
  que el saldo vuelve a `origValue / qty`. Funciona bien.
- Devolución de venta (`sales-returns.service.ts:153-162, 799-812`): la última devolución cierra
  contra el total devuelto, así que la división `totalCost / qty` redondeada que graba E-05 no deja
  residuo al devolver todo.
- Partido de bobina: las hijas toman `out.totalCost` (`coil-operations.service.ts:181`). Con E-05
  ahora heredan exactamente el valor de la madre. Es una mejora.
- `reserveQty` y la unidad de venta no intervienen en la rama nueva. `assertReservationInvariant`
  sigue viendo `newQty = 0`.
- La rama nueva solo corre con `laterCount = 0` o `atDate.qty ≤ 0`. Este segundo caso, con
  retrofecha, no debería llegar por D-652/D-662; si llegara, tomaría el valor a `KARDEX_END` y no
  a su fecha.

## Respuesta del autor (cc58)

- **P1-1:** corregido (el promedio se conserva; ver la respuesta al segundo modelo).
- **P1-2 y P2-1:** anular y editar una compra recibida y el borrador de producción quedan en 120 s
  como excepciones con nombre; se le avisa al dueño.
- **P2-2:** las operaciones del día bajan a 30 s por decisión del dueño (D-683). Ninguna recostea
  en bloque (lo confirmó el segundo modelo). `mountCoil` vuelve a crecer con las bobinas.
- **P2-3:** aceptado como riesgo y anotado: una diferencia real entre el saldo y el kardex pasa al
  costo de la última salida. `pnpm check:balances` en producción daba 2 diferencias de céntimos
  (cc57); se vuelve a correr en el corte de los céntimos (D-687).
- **P3:** comentarios corregidos; PEPS retroactivo va al handoff; el JSDoc de la clase queda sobre
  `pepsCorrectedCosts`: se mueve.
