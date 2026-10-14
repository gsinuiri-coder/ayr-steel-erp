# cc53 corte A — revisión de segundo modelo

Rama `cc53-a-recosteo`, diff `origin/main...cc53-a-recosteo` (56 archivos). Revisor: segundo modelo
(Sonnet, contexto limpio), solo lectura. No se ejecutó nada: todo lo de abajo sale de leer el
código. Sigue siendo un modelo, no una persona (AGENTS.md §2.2).

Alcance leído: migración, `schema.prisma`, `recost-engine.ts`, `inventory-recost.ts`,
`inventory.service.ts` (record, adjustCost, reverse, recostForward, listado de kardex),
`sales-returns.service.ts`, reportes (`sales-margin`, `sales-by-material`, `document-profitability`,
`production-summary`, `kardex-peps`), cambios web/shared. Los archivos sin seguimiento
(`recost-historic*.ts`, `scripts/recost-historic.mjs`, `package.json`) **no están en el diff
comprometido**; solo se miró que `recost-historic-cli.ts` escriba por `recostForward`.

## Resumen

- Ninguna fila se edita: la migración solo agrega `recost_of_id` (FK, CHECK `ADJUST`, índice), y
  todo recosteo es un `createMany` de `ADJUST` dentro de `InventoryService`. Dinero en `Decimal`
  en todo el código nuevo (sin `Number(`/`toNumber`). Los signos de Ventas y margen, ventas por
  material y rentabilidad por comprobante cierran (el `ADJUST` de recosteo siempre resta
  `-total_cost`, tanto sobre un `OUT` como sobre su reversa).
- 0 P0, 3 P1, 5 P2, 3 P3.

## P1

### P1-1. La devolución final de una NC arrastra el costo viejo de las devoluciones previas

`apps/api/src/invoicing/sales-returns.service.ts:84,133` + `sales-return-allocation.ts:108-110`.

`returnedTotalCost` se suma de `sales_return_items.total_cost` (lo grabado al devolver), pero
`totalCost` del `OUT` ahora es el **efectivo** (con recosteos). La última devolución (`whole`) vale
`s.totalCost - s.returnedTotalCost`. Si el `OUT` se recostea _después_ de una devolución parcial,
el reingreso de esa devolución también recibe su `ADJUST` (regla `RETURN` del motor), pero
`returnedTotalCost` sigue con el valor viejo.

Escenario: salida de 100 kg a 1 000. Se devuelven 40 kg a 400. Una entrada retrofechada sube el
`OUT` a 1 200 (el reingreso de 40 kg pasa a 480 por su `ADJUST`). Se devuelven los 60 kg restantes:
`whole` = 1 200 − 400 = **800**; lo proporcional es 720. El kardex gana 80 de valor que no existe y
el costo de venta de la NC queda 80 por debajo. Nadie lo corrige hasta un nuevo replay de esa fila.

Corrección: calcular `returnedTotalCost` con el costo efectivo de cada reingreso previo (su
`movement` + `recostOfId`, igual que `recostById` de las salidas), o armar la última devolución con
la regla del motor (`corrected × qty / source.qty`, restando lo efectivo ya devuelto).

### P1-2. Un recosteo se vuelve «el último movimiento» de la bobina y desarma la reapertura

`apps/api/src/coils/coil-operations.service.ts:1014-1027` (`reverseCloseAdjustment`).

Busca `findFirst({ itemType: COIL, itemId }, orderBy id desc)` y exige que sea el
`CLOSE_ADJUSTMENT` propio sin reversas ("nada se grabó después"). Los `ADJUST` de recosteo se
escriben con id mayor, con el `refType/refId` de la fila corregida y sin cantidad nueva.

- Si el recosteo cae sobre una fila con otro `ref` (p. ej. un consumo de producción de esa bobina,
  recosteado por un ajuste de flete fechado antes), `adjustment` queda `undefined` y la reapertura
  **no revierte** el ajuste de cierre: el escenario descrito en el comentario de esa función (kg de
  la nada en el siguiente ciclo cerrar→reabrir).
- Si el recosteo es sobre el propio `CLOSE_ADJUSTMENT` (un `OUT` AVERAGE) cumple
  `refType=CLOSE_ADJUSTMENT && refId=coilId`: `adjustment` pasa a ser el `ADJUST` de recosteo y
  `reverse()` revierte **solo ese recosteo** (el guard `recostOfId` de `reverseMovement` ~1036 no
  está en `reverse()`), informa `SURPLUS` (por `type !== 'OUT'`) y el ajuste de cierre real queda
  vivo.

Corrección: `where: { itemType: 'COIL', itemId: coilId, recostOfId: null }` en ese `findFirst`.
Misma forma en `coil-auto-terminate.ts:276` (`lastMovementByCoil`) y `terminate-zero-coils.ts:188`
(`lastMovementId`): también deben ignorar recosteos (ver P2-4). Añadir el guard `recostOfId` dentro
de `reverse()` como red.

### P1-3. Resumen de producción suma el recosteo de la anulación de un consumo anulado

`apps/api/src/reports/production-summary.service.ts:49`.

Filtro: `reversalOfId: null, reversals: none, OR[{recostOfId:null},{recostOf:{reversals:none}}]`.
Un reporte de producción anulado deja el `OUT` original (con `reversals`), su `IN` de reversa
(`reversalOfId != null`) y, tras un recosteo, un `ADJUST` sobre cada uno (la regla `REVERSAL`
recostea la reversa igual que el original). El `ADJUST` del original queda fuera, pero el del `IN`
de reversa cumple `recostOf.reversals none` → entra. `production-summary.ts:104` lo cuenta como
`-totalCost`: costo de material y despunte con un valor huérfano de igual magnitud al delta.

Escenario: se anula un reporte, después se carga una compra retrofechada que cambia el promedio de
esa bobina. El costo de material de la OP sale con −Δ de más.

Corrección: `{ recostOf: { reversals: { none: {} }, reversalOfId: null } }`. Mismo criterio en
`coil-waste` si algún día suma costo (hoy ignora `ADJUST`).

## P2

### P2-1. `recostForward` toma saldos fuera del orden canónico y no cubre la «lectura bajo lock»

`inventory.service.ts:431-452`.
`record()` ya tiene el saldo del disparador (`markBalanceHeld`). `lockInOrder` ordena solo el
conjunto del recosteo, no contra lo ya tomado: dos cascadas PRODUCT→PRODUCT con ids cruzados
(T1 retiene A y espera B; T2 retiene B y espera A) dan deadlock (40P01 → 409 por el filtro, sin
corrupción). Y para ítems `COIL`, `lockRawMaterialCoils` con saldo ya tomado pasa a `NOWAIT`: un
recosteo concurrente sobre bobinas compatibles responde 409 en vez de esperar. Además solo se
bloquean los ítems **con ajustes** del primer plan; un ítem que gana ajustes bajo el lock se lee
sin lock (tras 3 vueltas igual se sigue). El comentario «D-471» no se cumple del todo. No hay par
en `lock-order.db-spec.ts` para esta ruta (regla 17).

### P2-2. Ruido de redondeo escrito como recosteo

`recost-engine.ts` (`replayItem`, `RECOST_MIN_DELTA`) vs `record()` normal
(`totalCost = qty × balance.avgCost`, con `avg_cost` a 4 decimales).
El replay valoriza al promedio **exacto** (`value/qty`); lo grabado salió con el promedio
redondeado. La diferencia por fila es hasta `qty × 0.00005`: ≥ 0.01 con salidas de ~200 kg o más.
Toda retrofecha reescribe así «correcciones» de céntimos/decenas de céntimos en cada salida
posterior (hasta 500 filas), con su auditoría y cascada a lo producido. No es incorrecto pero
infla ajustes y audita ruido como si fuera recosteo. Sugerencia: umbral relativo (p. ej. máx(0.01,
qty×0.0001)) o replay con el promedio redondeado de 4 decimales como el camino en vivo.

### P2-3. Valor del saldo: SQL `stockAtDate` ≠ replay en períodos con stock cero

`inventory.service.ts:394-413` vs `replayItem`. El replay pone `value = 0` cuando `qty ≤ 0`; el SQL
suma todo. Un residuo de céntimos dejado por una salida que vació el ítem queda en el valor que
usa `record()` (promedio de la salida retrofechada y `newAvgCost`) y en el `avg_cost` que escribe
`recostForward`. El saldo y el kardex «Promedio» pueden diferir en centavos y el residuo se
contamina en el promedio de la siguiente retrofecha. Medir con un ítem vaciado y reabastecido.

### P2-4. Otros lectores de «último/ cualquier movimiento» ven los recosteos

- `coil-auto-terminate.ts:242,272`: la causa guardada de la terminación toma el último movimiento,
  que ahora puede ser un recosteo de otro `ref` → reapertura automática `OTHER_CAUSE`
  (falla segura, pero se pierde la reapertura).
- `purchase-received-edit.service.ts:448` (`landedCost: live.some(ADJUST && refId !== purchase.id)`)
  y `:1538`, `purchase-received-date-fix.ts:142`, `coil-restore.ts:145`: tratan cualquier `ADJUST`
  como landed cost. Un recosteo sobre la bobina activa la rama de landed cost o bloquea la
  edición/restauración. Excluir `recostOfId != null`.

### P2-5. «Material de planta» ignora el recosteo

`sales-margin.service.ts` `opMaterialByOrder`: `ELSE 0` para `ADJUST`. La columna de planta no
refleja los consumos recosteados mientras `production-summary` sí; la diferencia entre columnas
(que la columna existe para mostrar) pasa a mezclar costo original con corregido.

## P3

- P3-1. `planRecost` carga el kardex **completo** de cada ítem y de cada ítem en cascada (y dos
  veces, antes y bajo lock); `rowsReplayed` cuenta solo desde `start`. El tope de 500 no acota las
  lecturas; ítems con miles de filas pagan siempre. Considerar leer solo desde `start` + saldo
  inicial agregado.
- P3-2. `recostPending` deja la operación sin recosteo y sin reintento automático: tras ese caso, un
  segundo movimiento retrofechado en el mismo ítem arranca desde su posición y deja huecos hacia
  atrás hasta correr `recosteo:historico`. Documentado en D-649, solo conviene que el diálogo web lo
  avise.
- P3-3. Los archivos nuevos de la CLI histórica y `package.json` están sin seguimiento: si el corte
  A los incluye en la entrega, no fueron parte del diff revisado.

## Casos borde revisados sin hallazgo

- Salida que se lleva todo (`averageOutCost` toma todo el valor; el replay y `record()` coinciden).
- Saldo cero o ítem sin saldo a la fecha: `atDate.qty ≤ 0` cae al promedio de hoy; el replay deja la
  fila como se grabó (sin división por cero).
- Línea `NOOP`: `record` devuelve `null` antes de cualquier consulta; `adjustCost` igual; el
  recosteo no se llama.
- Reversa de una fila recosteada: usa `effectiveCost` (grabado + recosteos) y el replay la sigue
  sin delta; `reverseMovement` rechaza anular un `ADJUST` de recosteo.
- Devoluciones parciales _sin_ recosteo intermedio: la proporción cierra.
- Cascada producción/partido/corte/merma: la suma de partes de `prorateDelta` es exacta (el resto va
  a la parte de mayor peso).
- Kardex: el recosteo se pliega en su fila y el saldo corrido no salta; PEPS lo excluye a propósito.

## Veredicto

Corregir los 3 P1 antes del deploy. P2-1 y P2-4 conviene resolverlos en el mismo corte (son
cambios de una línea o un filtro); P2-2/P2-3 se pueden medir con la vista previa histórica antes de
decidir.
