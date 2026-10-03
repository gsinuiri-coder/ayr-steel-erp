# Revisión de segundo modelo — cc15a (D-372 sesión 2a, «Editar compra»)

Revisor: segundo modelo (Sonnet), contexto limpio, AGENTS.md §2.2.2. Diff `017564b..HEAD`, rama
`cc15/editar-compra-sesion2`. Es una lista de riesgos, no una aprobación. `jest src/purchases`:
9 suites, 122 tests en verde (no prueban el hallazgo P1, ver abajo). No se corrió E2E.

## P0

Ninguno.

## P1

### P1-1. La anulación de una compra con `COST_ADJUST` deja de ver el consumo anterior al ajuste

- Archivos: `apps/api/src/purchases/purchase-cancel.ts:19-26` (`lastOwnMovementByLiveItem`),
  usado en `purchases.service.ts:861` (`assertNothingMovedAfter`).
- La función mide «posterior» contra el **último** movimiento propio vivo del ítem, sea cual sea su
  tipo. Antes de cc15 una compra de bobina o producto solo tenía su `IN` (el único caso con `ADJUST`
  propio era el flete, que no tiene `IN`). Ahora `COST_ADJUST` agrega un `ADJUST` propio con
  `refType PURCHASE` y `refId` de la compra, con `id` mayor que cualquier salida previa.
- Escenario (producto con varias compras): compra A ingresa 100 u, se despachan 40, entra la compra
  B de 100, se corrige el precio de A (ADJUST, id máximo). Anular A: `lastOwnId` = id del ADJUST, no
  hay nada con `id >` y la guardia pasa. Se revierte el ADJUST y luego el `IN` de A (100 u); el
  saldo (160) alcanza, así que `inventory.reverse` no se queja. Resultado: la compra se anula con 40
  u ya despachadas, el stock queda en 60 y la salida nunca tuvo ingreso. Es exactamente lo que la
  guardia impedía.
- En bobinas el efecto es menor: `reverse` del `IN` falla por saldo (`quedan X de Y`), pero con un
  mensaje distinto al de la guardia y después de revertir el ADJUST dentro de la transacción (se
  deshace todo, sin daño).
- Corrección sugerida: por ítem, medir contra el último movimiento propio **de tipo `IN`** si el
  ítem tiene alguno vivo; solo si no tiene `IN` (flete) usar el último movimiento propio. Hace falta
  que el tipo llegue a `lastOwnMovementByLiveItem` (hoy el parámetro no lo trae; `own` en
  `purchases.service.ts:757` ya es el registro completo). Agregar un test: `IN`, `OUT` ajeno,
  `ADJUST` propio debe bloquear la anulación.

## P2

### P2-1. Costo de documento de la bobina doble en la anulación tras un `COST_ADJUST` parcial

- `purchases.service.ts:776-785` (`bumpCoilDocumentCost` sobre la reversa de cualquier ADJUST de
  bobina) con `purchase-received-edit.service.ts:758-761` (la edición ya reescribió
  `unitCostPerKg/totalCost/totalCostPen` completos).
- El ADJUST de `COST_ADJUST` es solo la parte proporcional (`diff × queda / lote`), pero la ficha
  ya recibió la diferencia entera. Al anular, la reversa resta el monto proporcional dividido por
  `movement.qty` (el saldo completo al momento del ajuste), no el cambio que sufrió la ficha. Sin
  consumo (`queda = lote`) revierte justo; con ADJUST parcial (necesita consumo, que P1-1 hoy deja
  pasar) la ficha queda a un costo que nunca existió. La bobina queda CANCELLED, así que el daño es
  de reportes que leen la ficha. Si se arregla P1-1 el caso solo sobrevive sin consumo y es inocuo;
  conviene dejarlo anotado o excluir los ADJUST con `refId === compra` de ese `bump`.

### P2-2. `adjustCost` puede fallar al guardar sin avisarlo en la vista previa

- `purchase-received-edit.service.ts:625-640` → `inventory.service.ts:~436-444`.
- Una baja de precio grande sobre una compra cuyo remanente está mezclado con lotes más baratos
  puede dejar `newValue < 0` (el valorizado promedio en stock es menor que el monto). La vista
  previa marca el cambio ejecutable (`adjustmentFor` no mira `balance.avgCost`) y el guardado
  responde 400 «deja el inventario con valor negativo». Todo o nada, sin corrupción, pero vista
  previa y guardado no coinciden. Sugerido: en `adjustmentFor`, si `amountPen < 0` y
  `|amountPen| > qty × avgCost` del saldo, devolver `BLOCKED` con ese motivo.

### P2-3. Un reintento con la misma `idempotencyKey` devuelve un plan vacío con `executable: false`

- `purchase-received-edit.service.ts:126-127`. El web lo trata como éxito (toast «Compra corregida»
  y `onSaved`), lo cual es correcto para el doble click. Pero cualquier otro cliente o un reintento
  tras un fallo no transaccional recibe `changes: []`. Aceptable; sugiero devolver el plan guardado
  o al menos un campo `replayed: true` para no confundir con «sin cambios».

## P3

- P3-1. `purchase-received-edit.service.ts:1009-1014`: las advertencias dicen «El ajuste se registra
  con la fecha de hoy» aun cuando `remainingQty = 0` o el monto redondea a 0 y no se escribe ningún
  ADJUST (`:625`). La ficha y los totales sí cambian. Mostrar un aviso propio («no queda nada de
  esta compra: solo cambia el papel y la ficha»).
- P3-2. El ADJUST queda con `qty` = saldo completo del ítem (`inventory.service.ts` `adjustCost`),
  no `remainingQty` del lote; en el kardex se lee como «afectó N kg» y no coincide con el texto de
  la vista previa. Y la reversa de un ADJUST (`reverse`) prorratea por `min(saldo, qty)`, supuesto
  que no vale para un ajuste de lote parcial. Hoy lo cubre el bloqueo de P1-1 corregido; anotarlo
  como límite conocido.
- P3-3. `purchase-received-edit.service.ts:884-897`: el remanente por PEPS es política (decisión A)
  sobre un kardex de costo promedio móvil. El valor total del inventario queda bien (el ADJUST suma
  al valorizado), pero el costo atribuido a cada salida posterior seguirá saliendo con el promedio
  nuevo de toda la mezcla, no con el del lote. Es coherente con lo dicho en `warnings`; solo
  conviene que el handoff lo diga explícito.
- P3-4. Los flejes nacidos de un partido (SPLIT) heredan el costo de la bobina madre y quedan al
  costo viejo; aparecen en la lista de «ya salió» como «Partido», pero el aviso no dice que sus
  fichas de costo no se corrigen.
- P3-5. `applyHeader` lanza 400 si pasa a `CREDITO` sin días **después** de haber escrito kardex
  (se deshace por la transacción) y la vista previa lo marca ejecutable. Ya existía antes de cc15;
  el web valida `creditDaysOk`, así que solo afecta a un cliente directo del API. Mover la
  validación al clasificador.

## Verificado sin hallazgo

- `fifoLotConsumption`: capas por llegada, salidas consumen primero las más antiguas, ADJUST no
  mueve cantidad, salida sin capas se ignora; el resultado se acota por el saldo bloqueado y por la
  cantidad del lote (`Decimal.max/min`). Sin `number` en dinero ni kg.
- Vista previa y guardado usan la misma `enrichPlan` y el mismo `adjustmentFor`; el guardado la
  recalcula bajo el lock de compra, de bobinas y de saldos (`lockBalances` va antes de leer).
- Deshacer sin consumo intermedio: la segunda edición ve la diferencia inversa sobre el mismo
  remanente y los importes del papel vuelven por `paperHistory` (`linesBefore` se registra también
  en la rama `COST_ADJUST`). Con consumo intermedio el resultado difiere y se avisa.
- Ediciones de cantidad/producto con ADJUST propio vivo siguen bloqueadas (el ADJUST cuenta como
  movimiento posterior), y `landedCost` ya distingue los ajustes ajenos (`refId !== compra`).
- `idempotencyKey` se reclama dentro de la transacción tras los locks y se libera si el guardado
  falla.
