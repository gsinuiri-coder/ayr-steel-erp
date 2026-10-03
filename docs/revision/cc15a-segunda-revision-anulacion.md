# cc15a — segunda revisión: guardrail de anulación y ajuste proporcional

Revisor de contexto limpio (modelo, no persona). Alcance: `purchase-cancel.ts`
(`lastOwnMovementByLiveItem`), `PurchasesService.cancel` / `assertNothingMovedAfter`
(`purchases.service.ts:700-895`) y `adjustmentFor` (`purchase-received-edit.service.ts:867-918`).
`pnpm --filter @ayr/api exec jest src/purchases`: 9 suites, 130 tests, verdes. No se corrió E2E.

## Veredicto

Sin P0 ni P1. No encontré otra forma de anular una compra con material ya consumido ni de dejar
saldo o valor negativo por los caminos pedidos. Hay dos P2 y varios P3.

## Caminos revisados sin hallazgo

- **Ajustes propios (`COST_ADJUST`, refId = compra):** la referencia es el ingreso vigente, no el
  ajuste. Una salida entre el ingreso y el ajuste sigue viéndose (id > ingreso). Si la salida se
  anuló después, no bloquea, y la reversa del ajuste (proporcional sobre lo que sobrevive) más la
  del ingreso dejan el ítem en cero: el valor cuadra (ingreso V0, salida q, ajuste rem×(nuevo−viejo),
  reversa de salida +q×viejo, reversa de ajuste, reversa de ingreso → 0).
- **Reingreso de «Editar compra» (reversa + ingreso nuevo, misma fecha):** `blockedBy` exige cero
  `laterMovements` vivos (en bobinas, todo movimiento vivo distinto del ingreso; en producto, id > ingreso
  O fecha > ingreso) para entrar por reversa y reingreso. Por eso mover la referencia al ingreso nuevo no
  oculta consumo. Un ajuste propio vivo cuenta como «posterior» (`consumed()`), así que tras un ajuste ya
  no hay reingreso por cantidad ni producto: no se llega al estado huérfano «ajuste vivo + ingreso nuevo»
  (que haría fallar la reversa del ajuste con «ya no tiene saldo»).
- **Cambio de producto:** el producto viejo (todo revertido) se ignora; el nuevo se mide contra su
  ingreso. El destino rechaza movimientos con fecha posterior a la recepción.
- **Landed cost de otra compra:** `landedCost` bloquea la edición de la bobina; y al anular la compra
  de la bobina, el ajuste ajeno (id > ingreso, vivo, no propio) bloquea. Al anular el flete se mide contra
  su último movimiento propio: cualquier movimiento posterior sobre esa bobina bloquea.
- **Salidas retrofechadas / reversas de salidas:** se miden por id; un par salida+reversa no bloquea
  (`liveMovements`). Retrofechada con id mayor: bloquea.
- **Partidos (SPLIT):** la salida del padre es posterior y viva: bloquea. Si se revirtió, no.
- **Corte tercerizado y flejes montados:** tienen sus chequeos propios (`cancel`, líneas 800-822).
- **Bobinas restauradas (D-375):** el ingreso de la restauración es `PURCHASE`/`refId = compra`, o sea
  ingreso vigente propio; el original está revertido. La referencia es la restauración.
- **Respaldo del kardex:** `InventoryService.reverse` de un `IN` rechaza si `origQty > balance.qty` y si
  el valor resultante es negativo con kilos. Es la red última cuando el ítem es una bobina.
  Con un producto que tiene stock de otras compras la red no basta, y por eso el guardrail por id importa.

## Hallazgos

### P2-1 — `take: 50` se aplica antes de filtrar lo propio y lo anulado

`apps/api/src/purchases/purchases.service.ts:873-886`

La consulta trae las primeras 50 filas con `id > referencia` de **todos** los ítems de la compra
(`OR` de hasta 200 ítems), y recién después descarta con `liveMovements` y `ownIds`. Las filas
descartables (pares salida+reversa y movimientos propios posteriores) cuentan contra el tope.

Escenario: compra de producto terminado, línea con el producto X. Tras la recepción se registran y
se anulan 26 salidas de X (52 filas: 26 salidas y 26 reversas) y luego una salida viva. Las 50 primeras
filas son todo par anulado; la salida viva es la fila 53 y no entra. `blocking` queda vacío, la
anulación sigue y revierte el ingreso. Si X tiene stock de otra compra, `reverse` no se queja y la
compra se anula con material consumido. Igual con una compra de muchas líneas con ajustes propios.

Corrección: filtrar en la base: `reversalOfId: null`, `reversals: { none: {} }` e `id: { notIn: [...ownIds] }`,
y recién ahí `take`. Test de regresión: 30 pares anulados + una salida viva.

### P2-2 — `adjustmentFor` en bobinas mezcla `remainingQty` con el saldo entero

`apps/api/src/purchases/purchase-received-edit.service.ts:903-907`

`target` usa `remainingQty × nuevo/lot` pero `current` usa `balanceQty × avgCost` (todo el saldo).
`remainingQty = min(fifo, balanceQty, lotQty)`; si `fifo < balanceQty`, `target − current` sale
muy negativo (se descuenta valor de kilos que no son de la compra). Con una bobina de un único lote
`fifo ≥ balance` y `remainingQty = balanceQty`, así que hoy no se dispara. Depende de que una bobina
nunca tenga un segundo ingreso vivo en su kardex (la restauración D-375 deja el original revertido), una
invariante que el código no afirma.
Corrección: `current = remainingQty × avgCost`; o afirmar `remainingQty.equals(balanceQty)` y
fallar con mensaje claro si no. Test con dos ingresos vivos en la misma bobina.

### P3-1 — La precisión del valor tras `adjustCost` es la del promedio guardado

`purchase-received-edit.service.ts:903-907`, `inventory.service.ts:429-440`

`current = qty × avgCost` es exacto, pero tras el ajuste el promedio nuevo se guarda con 4 decimales:
el valor resultante difiere de `target` hasta `qty × 5e-5` (una bobina de 20 000 kg: ≈ 1 sol). El texto
«lleva lo que queda al costo nuevo del papel» es aproximado a ese nivel. Sin impacto de negocio, pero
afecta la expectativa de un test o un UAT que compare al céntimo (redondeo del propio kardex).

### P3-2 — El guardrail de anulación usa solo id; la edición usa id o fecha

`purchases.service.ts:875` frente a `purchase-received-edit.service.ts:374`

Un movimiento del mismo producto con id menor pero `operationDate` posterior al ingreso propio no
bloquea la anulación (sí bloquea la edición). Hoy es inocuo: el ingreso entró después por id, la
anulación se fecha hoy y el kardex cronológico no queda negativo. Dejar documentado, o alinear criterios
si el dueño quiere que «consumido» sea cronológico. Relacionado: `loadTargets` (líneas 507-515) mide el
producto destino con `operationDate > receiptDate` estricto, sin filtrar anulados: un movimiento del
destino con la misma fecha de recepción no cuenta (y uno ya anulado sí).

### P3-3 — Dos líneas del mismo producto: la referencia es el mayor ingreso

`purchase-cancel.ts:35-41`

Con dos ingresos vivos del mismo producto, solo se mide contra el de mayor id. Un movimiento ajeno entre
ambos (solo posible por concurrencia en la recepción, ids consecutivos) no se vería. Con el criterio de
«último ingreso» era necesario para que el reingreso corra la referencia, pero ese caso ya está bloqueado
por `sharedProduct`. Opcional: medir contra el primer ingreso vivo cuando hay varios. Riesgo teórico.

### P3-4 — La lectura del guardrail no está bajo lock

`purchases.service.ts:763` y `inventory.service.ts:505`

La consulta de «posteriores» corre antes de que `reverse` tome el `FOR UPDATE` del saldo. Una salida que
confirme entre ambos solo la frena el chequeo de cantidad (`origQty > balance.qty`). Ya existía y no lo
introdujo este cambio; cualquier ítem con stock de otra compra pasa. Anotar como límite conocido.

## Pruebas que faltan

- `assertNothingMovedAfter` con más de 50 filas descartables antes de una viva (P2-1).
- `adjustmentFor` en bobina con `fifo < balance` (P2-2).
- Anulación tras reingreso por «Editar compra» con una salida ajena anterior al reingreso: la salida
  debe quedar bloqueada por la edición, no por la anulación (documenta el contrato entre ambos).
