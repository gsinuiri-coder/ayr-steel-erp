# cc57-b — Autorrevisión (no vale como pase cruzado)

> **Autorrevisión — no vale como pase cruzado.** Subagente nuevo, sin leer el handoff de
> implementación ni `docs/revision/` de la sesión. Es una lista de riesgos, no una aprobación.

Alcance: `git diff cc57-a-reversas...HEAD` (commit `0f963b08`; lo del merge del corte A queda fuera).
Solo lectura: no se corrieron tests, servidores ni bases. Lo que sigue sale de leer el código. Los
escenarios numéricos están hechos a mano y hay que reproducirlos en un db-spec antes de darlos por
ciertos.

## P1

### P1-1 — Reingreso al costo efectivo + cascada posterior: la hija se cuenta dos veces el recosteo anterior de la madre (se crea valor)

`apps/api/src/coils/coil-operations.service.ts:1255-1270` junto con
`apps/api/src/inventory/inventory-recost.ts:356-369`.

`planRecost` reparte `sourceDelta = efectivo(madre) − grabado(madre)`, es decir **todo** lo que la
madre se movió desde que se grabó, y lo suma sobre `t.recorded` de cada destino («las entradas
derivadas se grabaron con el costo grabado de sus salidas»). El reingreso de A-01 rompe ese
supuesto: ahora se graba con el costo **efectivo**, que ya trae una parte de ese mismo delta.

Escenario: un partido de una madre de 100 en dos hijas de 50/50, todo a costo 1.

1. Una compra atrasada de la madre: el OUT de la madre pasa a 200. Cada hija pasa a 100 efectivo
   (grabado 50 más un recosteo de 50).
2. «Editar bobina» sobre la hija 1, sin cambiar el costo (el formulario reenvía lo mismo). La reversa
   saca 100 y el reingreso se graba a **100**.
3. Otra compra atrasada de la madre: el OUT pasa a 250. `sourceDelta = 250 − 100 = 150`. Se reparte
   por valor grabado, 100:50, y queda 100 para el reingreso y 50 para la hija 2.
   - Hija 1: 100 + 100 = **200**. Lo correcto es 125.
   - Hija 2: 50 + 50 = 100, igual a su efectivo, así que **no recibe nada**. Lo correcto es 125.
   - Las hijas suman 300 contra los 250 que salieron de la madre: **se crean S/ 50** en el kardex.

El código anterior también fallaba aquí, por otro camino (perdía la mitad). El arreglo corrige el
paso 2 pero no el 3. El caso pide justo lo que A-01 dice resolver: una hija «ya recosteada» que se
edita y una madre que se recostea otra vez. Ningún test lo ejerce:

- el db-spec nuevo (`recost.db-spec.ts:550`) edita la hija **antes** de cualquier recosteo de la
  madre (`back.totalCost` = grabado);
- el unitario (`coil-split-cost.spec.ts:208`) solo mira el argumento de `record`.

Arreglo posible, a decidir: que el destino use como base el grabado de la entrada que reemplazó
(la anulada con el mismo ref), o que se reste del delta lo que el reingreso ya trae. Lo mismo
conviene mirar en el camino con costo nuevo explícito (`!costUnchanged`): el valor puesto por el
usuario más todo el delta histórico de la madre. Eso viene de antes, pero tiene la misma forma.

## P2

### P2-1 — «Editar compra recibida»: el plan dice que se puede y `replaceEntry` lo rechaza (CLOSE_ADJUSTMENT)

`apps/api/src/purchases/purchase-received-edit.ts:220` (`onlyLaterEntries = every(type === 'IN')`)
contra `apps/api/src/inventory/inventory.service.ts:1066`.

La precondición nueva (A-03) bloquea una entrada `IN CLOSE_ADJUSTMENT` posterior. `blockedBy` del
plan la sigue tratando como «otra entrada» y declara la línea ejecutable. Una bobina terminada con
conteo de más (D-164) no queda bloqueada por estado: `blockedBy` no mira `CLOSED`. El plan muestra
la corrección como posible, y al aplicarla sale un 400 con el enum crudo («movimiento posterior
(IN CLOSE_ADJUSTMENT)»). No hay test del plan para este caso.

Pasa lo mismo, en menor grado, con el recosteo del propio ingreso (`recostOfId = original.id`):
bloquea en la primitiva, pero el plan lo filtra con `recostOfId: null` (líneas 403, 482). Hoy no
ocurre, porque un ingreso `PURCHASE` nunca es destino de cascada (P3-4).

### P2-2 — Landed cost con fecha atrasada: se reparte con los kilos de hoy, a la fecha del papel

`apps/api/src/purchases/purchases.service.ts:1103-1135` (y `applyCuttingOrderCost`, `:1277`).

Antes, un flete atrasado con salidas posteriores se rechazaba. Ahora, con el acuse, entra:

- `prorateByWeight` usa `inventory_balances.qty` de **hoy**, y el ajuste se fecha el día del papel.
  Una bobina que se consumió el 90 % después de esa fecha recibe una parte mínima, aunque en la
  fecha del flete tenía tantos kilos como su gemela.
- Una bobina con saldo 0 hoy, pero con stock en la fecha, no recibe nada: `targets` filtra por el
  saldo de hoy, y `adjustCost` devuelve `null` con `balance.qty ≤ 0`. Su parte se pierde sin ruido
  (la recepción no aborta).

Además, el `ADJUST` guarda `qty` = saldo de hoy y `unitCost = amount / qty de hoy`. Es un dato
cosmético en la fila del kardex, pero ver P2-3.

### P2-3 — Anular ese flete atrasado devuelve de más

`apps/api/src/inventory/inventory.service.ts:907-924` (rama `ADJUST` de `reverse`), en el camino
de anulación de `purchases.service.ts:880`.

La reversa de un `ADJUST` saca `amount × min(saldo, ajuste.qty) / ajuste.qty`. Con D-03, `ajuste.qty`
es el saldo **posterior** a la merma (990 kg en el escenario del spec). La parte que la merma del
10/08 ya se llevó por recosteo (10/1000) no se descuenta: se devuelve el flete entero y la bobina
queda subvaluada en `amount × 0,01`. Si la anulación va fechada hoy, no hay recosteo que lo
compense (`laterCount = 0`). Ni este caso ni su anulación están cubiertos por tests.

### P2-4 — `check:balances`: la tolerancia fija de S/ 0,01 marca como diferencia el redondeo del promedio

`apps/api/prisma/check-balances-cli.ts:16,57`.

`savedValue = qty × avg_cost`, con el promedio guardado a 4 decimales. El kardex suma los totales
exactos. Solo el redondeo del promedio ya da hasta `qty × 0,00005`: unos S/ 0,25 en una bobina de
5 000 kg. Con S/ 0,01 fijos, buena parte de las bobinas grandes van a salir «con diferencia», y el
informe pierde utilidad para la ventana. Ya existe `isRoundingNoise(delta, qty)` en
`recost-engine.ts:259`, con `qty × 0,0001`: conviene usarlo.

Otros dos puntos de la CLI:

- Hace una consulta por saldo (`loadItem` y, si hay devoluciones, otra más) dentro de una sola
  transacción de 300 s contra el pooler de Neon. Con miles de saldos se acerca al límite.
- No ve los ítems que tienen kardex pero no tienen fila en `inventory_balances` (P3).

## P3

### P3-1 — Apertura del kardex con «desde» y la vista completa pueden diferir en el residuo

`inventory.service.ts:1880-1884`.

`openingBalance` solo descarta el residuo si la cantidad de apertura es ≤ 0. Si el ítem pasó por
cero **antes** de `from` y después se repuso (también antes de `from`), la suma SQL arrastra el
residuo, mientras que la vista sin `from` lo descarta en el cruce. La diferencia es del orden de
`qty × 0,00005`. El test (`recost.db-spec.ts:633`) solo cubre la apertura en cero.

### P3-2 — Excel del kardex (promedio): el saldo deja de cuadrar con entradas − salidas en el cruce por cero

`packages/shared/src/kardex-sheet.ts:126-128` toma `balanceTotalCost` de `findMovements`. En la fila
de la salida que agota el ítem, el saldo vale 0 y no `anterior − salida` (por ejemplo 0,0001). Es un
cambio buscado, pero visible para quien concilie la hoja a mano. PEPS no cambia: tiene su propio
cálculo.

### P3-3 — La vista solo pone el valor en cero con un OUT; el motor también lo reinicia con un IN sobre cantidad ≤ 0

`inventory.service.ts:1808` contra `recost-engine.ts:185` (`value = qty ≤ 0 ? row.effective : …`).
Solo divergen si un `ADJUST` cae con cantidad ≤ 0 en el kardex histórico, o con saldos negativos
anteriores a D-652. Es raro, pero «la vista no puede divergir del saldo» vuelve a no ser cierto en
ese borde.

### P3-4 — La rama «el recosteo del propio ingreso bloquea» de `replaceEntry` no tiene test y hoy no se alcanza

`inventory.service.ts:1071`. El único llamador es `purchase-received-edit.service.ts:891`, que pasa
ingresos `PURCHASE`. Esos ingresos tienen regla `FIXED` y no están en `CASCADE_REF_TYPES`, así que
nunca reciben `recost_of_id`. Está bien como defensa, pero sin cobertura.

### P3-5 — D-09: el reemplazo deja el par anulado con un costo que el motor ya no reproduciría

`replaceEntry` no recostea. Con el D-09 nuevo, un par salida + anulación posterior al ingreso deja de
bloquear. Su costo efectivo queda al promedio viejo. El saldo cuadra, porque el par se cancela,
pero un `recostForward` posterior, sembrado antes de ese par, va a escribir dos recosteos que se
cancelan entre sí. Es ruido en el kardex, no un error de valor.

### P3-6 — Cierre de drywall: `costAdjusted` / `costRecostedIntoEntries` sin test

`production/production.service.ts:1288-1289`. Nadie lee `costAdjusted` (grep), así que el riesgo es
solo de auditoría. `order-qty-change.db-spec.ts:844` cubre coberturas, no drywall.

### P3-7 — Cobertura de Sonar

Las líneas nuevas de `findMovements`, `openingBalance`, la precondición de `replaceEntry` y la
cascada solo se ejercen en db-specs. Los cambios en `inventory.service.spec.ts` solo adaptan el
discriminador del doble (`where.type ?? where.AND`) y no prueban la semántica nueva. Según la
experiencia previa, Sonar solo cuenta los unitarios, así que la cobertura de código nuevo puede
quedar corta.

## Cómo quedan los llamadores

| Pieza                                       | Llamadores                                                                                        | Cambio de comportamiento                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replaceEntry`                              | solo `purchase-received-edit.service.ts:891` («Editar compra recibida», precio/cantidad)          | Ahora bloquea si hay un `IN CLOSE_ADJUSTMENT` posterior (P2-1). Ya no bloquea por el recosteo de una salida anulada (D-09, correcto).                                                                                                                                     |
| `planRecost` / `recostForward`              | `record`, `reverse`, `adjustCost`, `recostEntries`, `recosteo:historico`                          | Los destinos anulados quedan fuera: corrige el reparto en hijas, flejes y OP reabiertas. Lo que se recostee de ahora en adelante en datos con historia ya repartida a medias le da todo el delta a la entrada viva, y eso se corrige solo. P1-1 en el reingreso efectivo. |
| `findMovements` / `openingBalance`          | `GET /inventory/movements`, `coils.service.ts:571`, `kardex-sheet.service.ts:31` (Excel promedio) | Saldo de valor en 0 en el cruce por cero (P3-1, P3-2, P3-3). PEPS no cambia.                                                                                                                                                                                              |
| `assertChronological`                       | `record`, `reverse`, `adjustCost`                                                                 | Solo cambia el número del mensaje. La condición de corte no cambia: un recosteo siempre va con la fecha de su fila.                                                                                                                                                       |
| `applyLandedCost` / `applyCuttingOrderCost` | solo `receive`                                                                                    | Con el acuse, ahora entra el flete atrasado (P2-2, P2-3).                                                                                                                                                                                                                 |

## Si los specs prueban lo que dicen

- `recost.db-spec` A-01 sí prueba que se excluye el ingreso anulado. **No** prueba el reingreso
  efectivo de `coil-operations` (llama a `inventory` directo, con una hija sin recosteo previo) ni
  una segunda cascada (P1-1).
- `recost.db-spec` A-06 es válido: reproduce el residuo de 0,0001 y prueba la vista y la apertura
  en cero.
- `replace-entry.db-spec` D-09 es válido: el recosteo de la salida anulada bloqueaba antes del
  cambio.
- `replace-entry.db-spec` A-03 prueba la primitiva sobre un `PRODUCT`, cuando en la realidad
  CLOSE_ADJUSTMENT es de bobina. No prueba el plan (P2-1).
- `replace-entry.db-spec` A-07 es válido: pasa de 3 a 2.
- `purchase-audit.db-spec` D-03 solo prueba que no lanza y que el `ADJUST` lleva la fecha del papel.
  No prueba que la merma reciba su parte, ni saldo = kardex, ni la anulación (P2-2, P2-3).
- `coil-split-cost.spec` prueba el argumento que se pasa a `record`, nada más.

## Resumen

Hay un P1. El reingreso al costo efectivo (A-01) corrige el saldo en el momento de editar la hija,
pero choca con la regla de cascada, que suma todo el delta histórico de la madre sobre el grabado
del destino. En la siguiente cascada, una hija editada después de un recosteo de la madre se queda
con valor que no existe y su gemela no recibe su parte. Ningún test lo cubre.

Hay cuatro P2:

- el plan de «Editar compra recibida» queda desalineado con la nueva precondición CLOSE_ADJUSTMENT;
- el landed cost atrasado se reparte con los kilos de hoy;
- anular ese landed cost devuelve de más;
- la tolerancia fija de `check:balances` va a llenar el informe de diferencias que son redondeo.

El resto (D-09, A-06, A-07, la exclusión de destinos anulados, la auditoría de drywall) se ve bien
encaminado. Quedan bordes P3 y poca cobertura unitaria.

---

## Respuesta del autor (cc57)

- **P1-1:** resuelto como en el segundo modelo. El costo de una bobina cuyo ingreso ya tiene recosteos ya no se cambia desde «Editar bobina»; vuelve el reingreso al grabado. Unitario en `coil-split-cost.spec.ts`.
- **P2-1:** `classifyReceivedEdit` ahora cuenta un `CLOSE_ADJUSTMENT` posterior como bloqueo, con su etiqueta. Unitario en `purchase-received-edit.spec.ts`.
- **P2-2 y P2-3:** con razón, D-03 abre el camino al flete retrofechado, que se reparte con los kilos de hoy y cuya reversa devuelve de más. Por eso **D-03 se retiró de este corte** y queda pendiente junto con D-10, que es la decisión del dueño sobre cómo repartir el landed cost en el tiempo.
- **P2-4:** tolerancia proporcional, igual que en el segundo modelo.
- **P3:** anotados.
