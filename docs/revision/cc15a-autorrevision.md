# cc15a — autorrevisión (D-372 sesión 2a)

> **Autorrevisión: lista de riesgos, no aprobación.** La hizo un subagente nuevo que no leyó el
> handoff de implementación (AGENTS.md §2.2.1). No vale como pase cruzado.

Alcance: `git diff 017564b..HEAD` en `cc15/editar-compra-sesion2` (commits `ebfda59`, `d14adc8`).
Método: lectura del código y cuentas a mano sobre escenarios concretos. No se corrieron tests.

## P0

### P0-1 — Un ajuste propio (`COST_ADJUST`) esconde el consumo del guardrail de anulación

- `apps/api/src/purchases/purchase-cancel.ts:15-27` (`lastOwnMovementByLiveItem`) y
  `apps/api/src/purchases/purchases.service.ts:861-866`.
- «Posterior» se mide contra el movimiento propio de **id más alto** del ítem. Hasta cc14 una compra
  de bienes solo tenía su `IN` (más reversas/reingresos sin nada entre medio). cc15 agrega un
  `ADJUST` propio (`refType PURCHASE`, `refId` = la compra) que se graba **después** del consumo que
  lo motivó. El ancla pasa a ser ese ajuste y la salida queda debajo, invisible.
- Escenario (producto terminado, saldo compartido): compra Y `IN 10` (id 100), compra X `IN 10`
  (id 101), despacho `OUT 8` (id 102), «Editar compra» de X corrige el precio → `ADJUST` propio
  (id 103). Anular X: `lastOwnId = 103`, la consulta busca `id > 103`, no encuentra nada y deja
  pasar. Revierte el `ADJUST` y después el `IN 10` de X: `reverse` solo exige saldo ≥ 10 y hay 12.
  Resultado: salen 10 a costo de X cuando a X le quedaban 2; los 8 de Y desaparecen del kardex sin
  documento. Antes de cc15 la misma anulación se rechazaba por el `OUT 102`.
- En bobina el mismo hueco termina en un error ruidoso pero engañoso: `reverse` del `IN` falla con
  «quedan 600 de los 1000» después de haber pasado el guardrail (`inventory.service.ts:521-526`).
- Sugerencia: anclar «posterior» en el **primer movimiento vivo** propio del ítem (o en el `IN`
  vivo cuando lo hay) y no en el último; para un flete (D-043) sigue siendo su `ADJUST`.
- Sin test: ni unitario ni E2E anulan una compra después de un `COST_ADJUST`.

## P1

### P1-1 — El monto del ajuste supone que todo «lo que queda» está al costo del papel; falla si se anula una salida afectada

- `apps/api/src/purchases/purchase-received-edit.service.ts:875-897` y `fifoLotConsumption`
  (`purchase-received-edit.ts:546-575`).
- `liveMovements` descarta los pares revertidos, así que una salida anulada **después** del ajuste
  se trata como si nunca hubiera ocurrido. Pero su reversa reingresó el material **al costo viejo**
  (`reverse` arrastra el mismo valor). La fórmula `diff × remaining / lote` le aplica la diferencia
  completa a material que en el kardex no tiene el costo del papel.
- Escenario medido a mano (bobina 1000 kg a 5): merma 400 → saldo 600 / 3000. Corrección a 5,5 →
  `ADJUST +300` → 600 / 3300. Se anula la merma → `IN 400` a 5 → 1000 / 5300 (prom. 5,30).
  «Deshacer» a 5: la merma y su reversa salen del cálculo, `laterMovements = [ADJUST propio]` →
  `COST_ADJUST`, remanente PEPS 1000, monto `−500 × 1000/1000 = −500` → 1000 / 4800 (prom. 4,80),
  con la factura y la ficha en 5. Faltan 200 soles en el kardex y no hay ninguna salida «que
  conserve su costo» que lo justifique; el aviso de la vista previa no lo cubre.
- Mismo error en una segunda corrección hacia arriba (5,5 → 6: `+500` sobre 1000 → prom. 5,80, no 6).
- Sugerencia: en bobina el monto puede salir del valor real del saldo (`objetivo − qty×avgCost`
  sobre lo que queda); en producto terminado hace falta llevar la cuenta de lo que la compra ya
  ajustó o bloquear el ajuste cuando hay reversas de salidas posteriores al último ajuste propio.

## P2

### P2-1 — Un PEPS distinto al del reporte `kardex-peps`

- `purchase-received-edit.ts:546-575` frente a `apps/api/src/reports/kardex-peps.ts:13-27`.
- El reporte devuelve la porción de una salida anulada **al frente de la cola** y reparte un
  `ADJUST` sobre todas las capas vivas por kilos; `fifoLotConsumption` borra los pares revertidos e
  ignora los ajustes. Con una salida anulada entre medio (OUT t1 de lote A, OUT t2 de lote B, se
  anula t1) las dos cuentas atribuyen distinto y la lista de «afectados»/remanente de la vista
  previa no coincide con lo que muestra el reporte PEPS.
- En producto terminado con varios lotes, el reporte PEPS repartirá el ajuste de X entre todas las
  capas (también las de Y): lo que la vista previa promete («lo que queda de esta compra, a costo
  nuevo») no se ve así en el reporte. La E2E solo verifica bobina (un lote), donde coinciden.

### P2-2 — Orden PEPS alterado por un reingreso previo de cc14 y salidas retrofechadas

- `purchase-received-edit.service.ts:881` ordena por `operationDate, at, id`. El reingreso de cc14
  conserva la fecha original pero tiene `at` nuevo: queda detrás de otros ingresos del mismo día
  grabados entre medio, y PEPS lo trata como lote más nuevo → remanente sobreestimado.
- Una salida retrofechada antes del ingreso propio, sin capas anteriores suficientes, descarta el
  resto (`fifoLotConsumption` «el resto se ignora»), cuando en el saldo real salió de este lote. El
  tope por saldo (`:892`) solo corrige si las demás capas ya estaban agotadas.

### P2-3 — Tras un ajuste propio la cantidad queda bloqueada para siempre con un mensaje imposible

- `purchase-received-edit.service.ts:334` (bobina) y `:377/399` (producto): el `ADJUST` propio entra
  en `laterMovements`. Aunque después se anulen todas las salidas, la cantidad y el producto quedan
  bloqueados con «revierte esas operaciones primero» nombrando `PURCHASE`, que el usuario no puede
  revertir. `consumed()` (`purchase-received-edit.ts:230`) también manda el precio a `COST_ADJUST`
  sin consumo vivo.

### P2-4 — Cobertura de tests frente a lo pedido

- Falta: anulación después de un `COST_ADJUST` (P0-1); `COST_ADJUST` de producto terminado con
  varios lotes en servicio o E2E; `fifoLotConsumption` con reversas, retrofechas y lotes repetidos
  (los unitarios, `purchase-received-edit.spec.ts:148-178`, cubren dos casos simples); deshacer con
  una salida **anulada** entre las dos ediciones (P1-1). El «deshacer con consumo entre medio»
  pedido sí está (`e2e/tests/editar-compra-recibida-cc15a.spec.ts:195-227`, bobina).

## P3

- **Idempotencia con otro payload**: `claimIdempotencyKey` (`purchase-received-edit.service.ts:126-127`)
  devuelve plan vacío y el controlador responde 200 con la compra; la web muestra «Compra corregida»
  sin haber escrito nada. El hook de la web genera una clave por huella, así que no pasa desde la
  UI; sí desde otro cliente que reutilice la clave.
- **Vista previa ≠ guardado en días de crédito**: `purchase-received-edit.ts:324` muestra
  «Días de crédito → vacío» cuando la compra es de contado con `creditDays` heredado, aunque la
  edición no toque condición, días ni fecha; `applyHeader` (`service.ts:1096-1109`) no lo escribe.
  Queda auditado un cambio que no se hizo. Solo con datos viejos inconsistentes.
- **Ajuste negativo mayor que el valor en stock**: la vista previa lo muestra ejecutable y el
  guardado falla en `adjustCost` («valor negativo», `inventory.service.ts:429-434`). Raro en la práctica.
- **Anulación de bobina tras ajuste propio sin consumo vivo**: `cancel` aplica
  `bumpCoilDocumentCost(−ajuste)` (`purchases.service.ts:775-783`) sobre una ficha que cc15 ya fijó
  al precio del papel (decisión C). La bobina queda anulada, así que el efecto es cosmético.
- **Restauración de bobina (D-375)**: un `IN` de restauración abre otra capa en PEPS; el remanente
  de «esta compra» puede salir 0 aunque el material restaurado sea el mismo.
- **Solo ingresos posteriores bloquean y con consumo no**: un producto con otra compra posterior
  y sin salidas queda bloqueado («próxima versión»), y con una salida más pasa a `COST_ADJUST`.
  Es coherente con lo que dice el spec de cc15b, pero conviene que el dueño lo sepa.
- `dueDateOf` (`purchase-received-edit.ts:41-50`) duplica `computeDueDate`; la nota del ajuste
  formatea la cantidad con escala `KG` también para unidades `NIU`.

## Lo que se miró y no dio hallazgo

- Signo y TC del monto: `cents(nuevo×TC) − cents(viejo×TC)`, con la misma base que el ingreso
  (`receptionCost`). Al deshacer se usan los importes del papel restaurados (D-359), así que la
  diferencia es la negación exacta de la primera.
- Locks: `commit` toma la compra, las bobinas y los saldos (también los de destino) antes de la
  clave de idempotencia y de leer movimientos; `adjustmentFor` lee bajo esos locks.
- La vista previa y el guardado comparten `enrichPlan`; el guardado lo corre después del chequeo
  `executable`.
- `landedCost` excluye solo `ADJUST` con `refId` = la compra; un flete posterior sigue bloqueando.
- La clave se reclama dentro de la transacción: un 4xx hace rollback y no la deja guardada.
