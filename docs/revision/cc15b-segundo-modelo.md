# cc15b — revisión de segundo modelo (AGENTS.md §2.2.2)

Rama `cc15b/reemplazo-con-reserva`, diff `56e068e..HEAD`. Foco: `InventoryService.replaceEntry`
(`apps/api/src/inventory/inventory.service.ts`) y su uso en
`apps/api/src/purchases/purchase-received-edit.service.ts`. Contexto limpio, sin haber leído el
handoff. Corrí `pnpm --filter @ayr/api exec jest src/inventory src/purchases`: 16 suites, 184 tests
verdes. No corrí E2E ni `test:db`; el análisis de concurrencia es de lectura del código.

Resumen: **0 P0, 1 P1, 2 P2, 4 P3.** El refactor de `record`/`reverse` conserva su comportamiento
(salvo un caso de saldo negativo que no debería existir, P3-1). Las reservas y la materia prima
sobre el estado final, el lock y la releída del ingreso bajo el lock están bien; el agujero está en
la precondición.

## P1-1 — La precondición ignora salidas ya anuladas: el saldo corrido del kardex queda negativo

`inventory.service.ts`, consulta `later` de `replaceEntry` (filtros `reversalOfId: null` y
`reversals: { none: {} }`), y el test que lo consagra en
`apps/api/src/inventory/replace-entry.db-spec.ts` («una salida posterior ya anulada no cuenta»).

Escenario, paso a paso (flujo corriente, sin nada raro):

1. Lunes (D): compra recibida de 100 kg del producto P. Ingreso IN 100, fecha D.
2. Martes (X > D): despacho de venta, OUT 100, fecha X. Saldo 0.
3. Miércoles (Y > X): se anula el despacho. `reverse` mete un IN 100 con fecha Y (por defecto hoy,
   D-124). Saldo 100. La salida original queda «anulada».
4. Jueves: el administrador corrige la compra, cantidad 100 a 50. El clasificador usa
   `liveMovements`, que quita el par salida/reversa, así que no ve nada posterior y deja pasar. La
   primitiva repite el filtro y tampoco lo ve.
5. `replaceEntry` escribe reversa OUT 100 y reingreso IN 50, ambos con fecha D. Saldo final 50. Las
   reservas y el valorizado final son coherentes.
6. Saldo corrido del kardex ordenado por `(operationDate, id)`: D: +100, -100, +50 = 50; **X: -100
   = -50**; Y: +100 = 50. El kardex muestra -50 kg el martes, y esa fecha nunca tuvo ese saldo.

Es exactamente lo que la nota del docblock («desde la fecha del ingreso hasta hoy solo se suma»)
dice que no puede pasar. El mismo hueco con el precio: IN 100 a 10, salida de 1000 valorizada al
promedio viejo, anulación; se corrige el precio a 20: el valorizado corrido queda en 1000 con cero
kilos el día X, y el saldo final es coherente.

El saldo final no se rompe (`inventory_balances.qty` es correcto) ni hay reservas en descubierto,
pero se viola la invariante de saldo corrido que el pedido pide cuidar. Con la fecha de la
reversa/ingreso igual a la del ingreso original, cualquier salida anulada con fecha posterior
reabre el problema. También aplica a ajustes anulados, en valor.

Corrección sugerida, en orden de robustez:

- Comprobar la invariante en vez de aproximarla: bajo el lock, calcular en SQL el saldo corrido
  mínimo con ventana (`SUM(±qty) OVER (ORDER BY operation_date, id)`) sobre los movimientos del
  ítem desde la fecha D, **con el reemplazo ya aplicado** (restando el IN original y sumando el
  nuevo con fecha D), y rechazar si algún punto queda por debajo de cero. Es lo que cubre salidas
  anuladas, ajustes, y el orden por fecha.
- Más barata: tratar como bloqueantes también los pares anulados cuyo original tenga fecha
  posterior a D (o id posterior) **y** cuya reversa tenga fecha posterior al original. Obliga a un
  mensaje distinto, porque «revierte esas operaciones primero» ya no aplica.
- En cualquier caso, agregar al db-spec un caso con el orden D < X < Y y una baja de cantidad, y
  cambiar el caso actual, que usa todo en la misma fecha y por eso no ve el problema.
- Reflejarlo también en `load`/`blockedBy` (el mismo `liveMovements` oculta el par).

## P2-1 — Orden de locks invertido entre la edición de la compra y la confirmación de pedidos (deadlock)

`purchase-received-edit.service.ts:111-123` (compra, bobinas propias y saldos) contra
`inventory.service.ts`, `replaceEntry` (`lockRawMaterialCoils` después de `lockBalance`).

El comentario de `replaceEntry` dice que toma las bobinas antes que el saldo. Es cierto dentro de la
primitiva, pero cuando la llama la edición de una compra de bobinas, el saldo de la bobina ya fue
bloqueado por `lockBalances` (línea 123), y `lockRawMaterialCoils` se ejecuta **después**, para
todas las bobinas compatibles (incluidas las de otras compras).

1. T1 (edición): bloquea la compra, la bobina A (propia) y el saldo de A.
2. T2 (confirmar un pedido con material a medida): `lockRawMaterialCoils` bloquea, en orden de id, B
   (B < A) y se queda esperando a A, que tiene T1.
3. T1 entra a `replaceEntry` y su `lockRawMaterialCoils` pide B: lo tiene T2. Deadlock. Postgres
   aborta a una de las dos con 40P01 y el usuario ve un 500.

No corrompe datos (rollback), pero es el orden inverso que D-134 prohíbe, y es probable si hay
bobinas compatibles. Corrección: en `commit`, reemplazar el `SELECT ... FOR UPDATE` de las bobinas
propias (línea 118) por `lockRawMaterialCoils(tx, coilIds, tolerancia)` antes de `lockBalances`; en
`replaceEntry` la llamada interna queda como no-op rápido. Un test de `db-spec` con dos
transacciones lo fija.

## P2-2 — `reverse` sigue tomando el saldo antes que las bobinas

`inventory.service.ts`, `reverse` (comprobación de materia prima tras `lockBalance`, sin
`lockRawMaterialCoils` previo), contra `replaceEntry`, que sí las toma antes. No lo introduce este
diff (viene del código base y se nota por contraste), pero ahora hay dos puertas que reversan un
ingreso de bobina con órdenes de lock opuestos: una anulación de bobina concurrente con una
edición puede cruzarse. En la compra el lock de la compra serializa ambas; el cruce queda en las
rutas que llaman a `reverse` sin pasar por la compra (anular bobina, restaurar bobina). Corrección:
`lockRawMaterialCoils` antes de `lockBalance` en `reverse` cuando el ítem es `COIL` y es un `IN`
(igual que `record` para las salidas).

## P3

1. **`record` ya no es idéntico con saldo negativo o cero con valor.**
   `inventory.service.ts`, `stockAfterIn`/`avgOf`. Antes, con `balance.qty <= 0`, el promedio nuevo
   era `totalCost / qty`; ahora es `totalCost / (balance.qty + qty)`, y `0` si eso no es positivo.
   Idéntico con saldo exactamente 0 (el caso normal). Un saldo negativo no debería existir
   (`record` lo impide y no hay `CHECK` en la base); si existiera por datos viejos, el resultado
   cambia. Corrección: en `stockAfterIn`, cuando `stock.qty <= 0`, que el valor sea `totalCost` y
   la cantidad `qty` (descartando el saldo previo), o dejar un test que fije la decisión.
2. **El centinela de escritores se puede esquivar.** `kardex-writers.sentinel.spec.ts`: la regex SQL
   exige el nombre pegado a `INSERT INTO|UPDATE|DELETE FROM` (`"public"."inventory_movements"` no
   la dispara); no ve `tx['inventoryMovement'].create`, escrituras anidadas (`coil.update({ data: {
movements: { create } } })`) ni `$executeRawUnsafe` con el nombre armado. Aceptable como red
   barata si se documenta; la regex puede aceptar un prefijo de esquema opcional
   (`(?:"?\w+"?\.)?`).
3. **Anulación concurrente de `reverse` contra `replaceEntry`.** `reverse` lee el movimiento
   (`reversibleMovement`) antes de tomar el lock del saldo (igual que antes del refactor). Si un
   `replaceEntry` gana el lock y termina, `reverse` ya habría comprobado «no anulado»; con el lock
   obtenido calcula sobre el saldo nuevo y puede fallar con un mensaje engañoso («quedan X de los
   Y»), o llegar al índice único y salir con 409. No hay corrupción, la transacción se revierte.
   Corrección menor: releer `reversibleMovement` después del lock, como hace `replaceEntry`.
4. **Reversa con fecha heredada.** `replaceEntry` fecha la reversa con la del ingreso. Es el diseño
   (D-045 generalizado), pero contradice la letra de D-124 («la reversa jamás hereda la fecha»);
   conviene que la decisión nueva lo diga explícitamente y que el aviso de la vista previa avise que
   cambia el kardex de la fecha del ingreso, no el de hoy.

## Lo que intenté y no rompí

- **Saldo final negativo:** con solo entradas posteriores, `balance.qty >= origQty`, así que
  `stockAfterReverseIn` no falla y la cantidad nueva es positiva. Probé reemplazos con otras
  entradas en la misma fecha y en fechas posteriores: bien. Una salida con id anterior pero fecha
  igual al ingreso queda antes en el orden `(fecha, id)` y no se ve afectada.
- **Reservas por una carrera:** crear una reserva pasa por `lockAvailability`, que toma el mismo
  `FOR UPDATE` del saldo. Con el lock tomado y la reserva leída después, ni una reserva nueva ni una
  salida pueden colarse. Una reserva anterior se compara contra `after.qty` (estado final); si la
  cantidad sube o queda igual, el chequeo se omite, correcto.
- **Dos ingresos vivos / doble reversa:** `reversibleMovement` bajo el lock más el índice único
  `reversal_of_id` lo impiden; el db-spec lo cubre con dos reemplazos simultáneos.
- **Materia prima (D-134):** `assertRawMaterialInvariant` corre tras escribir el saldo y solo si la
  cantidad baja; el cambio de precio no mueve kilos. La simulación con `coilQtyOverrides` coincide
  con el estado final.
- **Valorizado/promedio:** una sola cuenta con `Decimal`, un solo redondeo a 4 decimales; sin otras
  existencias el promedio queda exacto (el db-spec lo prueba), y con otras el desvío ±0,0001 está
  advertido.
- **Puertas del kardex:** `createMovement` y `writeBalance` son privados y solo los usan `record`,
  `reverse` y `replaceEntry`; `adjustCost` conserva sus escrituras directas dentro del mismo
  servicio. `P2002` en `createMovement` solo puede dispararse con `reversalOfId`, el único índice
  único de la tabla.
- **Refactor de `reverse`:** mismas comprobaciones en el mismo orden (`assertChronological`, tope por
  cantidad, valor negativo, reservas, escritura, materia prima, fila). Mismos mensajes.
