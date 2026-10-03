# cc14 (D-372, editar compra recibida) — revisión de segundo modelo

Revisor: Sonnet 5.5, contexto limpio (AGENTS.md §2.2.2). Alcance: `git diff 14db1eb..HEAD` completo (API,
shared, diálogo web, specs). Se corrió `jest src/purchases/purchase-received-edit`: 36 pruebas en verde.
No se corrió E2E. No es una aprobación: es una lista de riesgos.

Resumen: **0 P0, 2 P1, 5 P2, 4 P3.** La mecánica de kardex (reversa del IN y nuevo IN en la misma fecha vía
`InventoryService`, `liveMovements`, re-edición viendo el ingreso nuevo como único vivo) es correcta en el
camino feliz. Los P1 son dos huecos donde se escribe sin kardex o contra un estado que cambió.

## P1

### P1-1. Cambio de precio/cantidad/producto sin ingreso vivo se aplica en silencio, sin mover kardex

`apps/api/src/purchases/purchase-received-edit.service.ts:461` (`if ((amountsChange || productChange) && loadedItem.ownIn)`),
con `load()` en :183-226 y :240-243, y el clasificador `purchase-received-edit.ts:119-154`.

Cuando `ownIn` es `null`, el clasificador no lo sabe: `blockedBy` no lo mira. `ownIn` es `null` si
(a) la línea de una compra COIL no tiene bobina con `purchaseItemId` (el `where` de :185 excluye
`purchaseItemId: null`, y las bobinas de cargas antiguas o de planilla pueden no tenerlo);
(b) la primera movimiento vivo de la bobina no es `IN`; o (c) en FINISHED_GOOD el IN de la compra ya
no está vivo. En (a) `laterMovements` queda vacío, la línea sale `REVERSE_REENTRY` ejecutable, y el commit
salta la reversa/reingreso y aun así actualiza `purchase_items` (qty, precio, subtotal, igv, total) y los
totales de la cabecera (:523-531, :677-688). Resultado: compra y kardex divergen y nadie lo ve; la
auditoría dice `reversedMovementIds: []` pero el plan mostró «Reversa y nuevo ingreso».
Corrección: en `ItemFacts` añadir `hasLiveIn: boolean` y en `blockedBy` (grupos COST y KARDEX, y spec de bobina)
devolver «La línea no tiene un ingreso de kardex vivo que corregir». En `applyItems` lanzar
`BadRequestException` en vez de continuar si `(amountsChange || productChange) && !ownIn`. Añadir prueba.

### P1-2. Los saldos no se bloquean antes de leer los «movimientos posteriores»; solo hay `FOR UPDATE` de compra y bobinas

`purchase-received-edit.service.ts:100-112` y :244-256. El diseño (§3) pide lock de compra, bobinas **y**
saldos (`lockAvailability`). El propio comentario de `raw-material.ts:705-715` documenta que quien
consume (salida de kardex) toma `inventory_balances` y NO `coils`: los dos caminos toman filas disjuntas.
Escenario: se previsualiza y se confirma; entre `load()` (:110, sin movimientos posteriores) y
`inventory.reverse` (:477) otra transacción confirma un ADJUST positivo (landed cost de otra compra) o un
IN de otra compra del mismo producto FINISHED_GOOD. `reverse` revierte el IN con su costo original y el
reingreso recalcula un promedio sobre un saldo distinto del que se clasificó. Para OUT parcial el chequeo
`origQty > balance.qty` de `reverse` lo salva; para ADJUST o IN ajenos no. En FINISHED_GOOD no hay lock de
fila ninguno sobre el producto antes de leer `later`.
Corrección: dentro del commit, antes de `load()`, tomar el lock de balance de los ítems involucrados (ids de
bobina y `productId` actuales y destino) en orden estable (el mismo `lockBalance`/`lockAvailability` que usa
`InventoryService`), o bien reclasificar después de bloquear. Ventana pequeña pero es dinero de kardex.

## P2

### P2-1. «Re-editar al valor anterior vuelve exactamente al inicio» no se cumple con importes del papel (D-359)

`purchase-received-edit.service.ts:452-458` y :486-496. Una línea importada guarda el `subtotal` e `igv` del
papel, que no son `qty × precio` (D-359). Al editar precio y volver, el segundo commit recalcula
`editedLineAmounts(qty, precio, rate)`: subtotal = `money(qty × precio)` y el IGV por la tasa implícita. La
línea, el total de la cabecera, `coil.totalCost(Pen)` y el IN nuevo quedan unos céntimos distintos del
original del papel. El kardex no vuelve exacto; el total por pagar tampoco. Corrección: guardar en la
auditoría (o derivar) los importes de papel y, si el nuevo (qty, precio) coincide con los del estado
original auditado, restaurarlos; como mínimo advertirlo en la vista previa («los importes del papel se
recalculan como cantidad × precio») y documentarlo en la decisión. Si no, retirar la afirmación de «deshacer exacto».

### P2-2. `impliedIgvRatePct` se evalúa siempre y puede rechazar una edición de pura cáscara

`purchase-received-edit.service.ts:422`, calculada en `applyItems` aunque `input.items` esté vacío, fuera del
clasificador. Una compra recibida con tasa implícita no estándar (por redondeo de papel mayor a 0,1 punto o
mezcla de tasas) lanza 400 «no tiene una tasa de IGV estándar» al guardar solo una observación o un número,
y la vista previa lo mostró como ejecutable. Corrección: calcular `rate` solo si hay líneas con
`amountsChange`, y mover esa validación al clasificador para que salga en la vista previa. Lo mismo vale
para `applyHeader`: recalcula `subtotal/igv/total/totalPen` desde las líneas en TODA edición (:677-688), incluso
de cáscara. Si la cabecera no era igual a la suma de líneas, una edición de observaciones cambia el total por
pagar. Escribir los totales solo si cambió alguna línea.

### P2-3. Reversa bloqueada por reservas o por el agregado de materia prima: el bloqueo no sale en la vista previa y frena ediciones que no deberían bloquearse

`purchase-received-edit.service.ts:477` → `inventory.reverse` (`inventory.service.ts:575-600`) ejecuta
`assertReservationInvariant` y `assertRawMaterialInvariant` con el saldo en cero. Una edición solo de precio de una
bobina (o de un producto) cuyo agregado color/espesor está prometido a pedidos, o cuyo SKU tiene reserva,
falla en el commit con «no se puede anular el ingreso…», un mensaje de anulación de compra, no de edición.
Preview y comprobación de bloqueo (`ownReservation`, solo para el grupo KARDEX, :150) no lo anticipan. El
usuario ve «Reversa y nuevo ingreso» ejecutable y luego un 400 críptico. Además, un cambio de **solo precio** no
cambia la cantidad, así que bloquear por la reserva es evitable. Corrección: (a) en preview, correr la misma
comprobación en solo lectura y marcar `BLOCKED` con el pedido nombrado; (b) mejor, para precio sin cambio de
cantidad, hacer el IN nuevo antes de la reversa dentro de la transacción (saldo nunca cae a cero), o pasar un
indicador interno a `reverse` para omitir la invariante cuando el reingreso inmediato restituye la cantidad. Para
FINISHED_GOOD tampoco se mira reserva en `blockedBy` (`ownReservation: false` fijo en :268).

### P2-4. Una edición puede crear un `sharedProduct` y dos líneas pueden mandar el mismo producto en una misma petición

`purchase-received-edit.ts:290-310`. El clasificador valida `sharedProduct` solo con el estado actual; si el
usuario cambia la línea 1 al producto de la línea 2 (o ambas al mismo), se aplican dos INs del mismo producto
bajo el mismo `refId` y la compra queda en un estado que el propio sistema bloquea después (:136) y que
`ownLive.find(...)` (:242) no sabe separar: la línea siguiente no se puede volver a editar ni deshacer.
Corrección: en el clasificador contar `productId` resultantes (actuales + ediciones) y bloquear si
algún producto queda en más de una línea.

### P2-5. Doble ítem repetido en el cuerpo; fuga de estado en `applyItems`

`purchase-received-edit.service.ts:429-435` itera `input.items` buscando `purchase.items` ya leídos. Si el
mismo `itemId` viene dos veces, la segunda pasada usa el `ownIn` ya revertido y `reverse` falla con 409 «ya fue
anulado» tras haber hecho la primera (la transacción hace rollback, así que es seguro, pero el mensaje engaña),
y la vista previa del clasificador no lo detecta. Corrección: `superRefine` en `editReceivedPurchaseSchema`
rechazando `itemId` duplicado.

## P3

- **P3-1.** `purchase-received-edit.service.ts:147`: timeout fijo de 60 s para hasta 200 líneas con varios viajes a
  Neon por línea; `cancel` usa 120 s por lo mismo. Subir o limitar `items.max` a un valor medido.
- **P3-2.** AGENTS §3.4 «operaciones repetibles llevan `idempotencyKey`»: el commit no la lleva. En la práctica es
  idempotente (un reintento ve un plan vacío y no escribe), pero devuelve la compra sin avisar que no hizo nada;
  vale una nota o un test que lo fije.
- **P3-3.** `edit-received-purchase-dialog.tsx:182-183,192-193`: el diálogo exige serie `^[A-Z0-9]{1,10}$` y número
  `^[0-9]{1,20}$`, igual que el API, pero si alguna compra importada tiene un valor fuera del patrón, la lista de
  errores bloquea «Revisar cambios» aunque el usuario solo quiera corregir un precio. Validar solo si el campo cambió.
- **P3-4.** Diálogo: al pasar de CRÉDITO a CONTADO el API pone `creditDays = null` y recalcula `dueDate`, pero la
  vista previa no lista ninguno de los dos. `dueDate` tampoco figura como cambio cuando se edita la fecha de emisión.
  El tipo de retorno declarado del commit en el diálogo (`PurchaseDto`) es el correcto; el servicio devuelve un plan
  que el controlador descarta (`purchases.controller.ts`), sin problema.

## Lo que se revisó y está bien

- Kardex append-only: la reversa y el IN nuevo salen por `InventoryService.reverse/record`; `date` y
  `confirmBackdate` se usan como en D-045; `liveMovements` deja al IN nuevo como único vivo, y `cancel`
  (`purchases.service.ts:789-826`) sigue funcionando porque compara contra el último movimiento propio por ítem.
- Decimal: no se usa `number` para dinero ni kg (`toDecimal`, `cents`, `toFixedString`); `creditDays` es entero.
- Bloqueos: pagos vigentes, `IN_THIRD_PARTY`, montada, landed cost, consumo posterior con detalle, producto
  compartido y especificación en el lugar solo con bobina intacta.
- D-134: `assertRawMaterialInvariant` con `alsoAffecting` para el cambio de acabado/espesor; el ancho no afecta
  el agregado.
- El diálogo envía exactamente el `payload` previsualizado (llave `JSON.stringify(payload)`), borra la vista
  previa en cada cambio y el commit manda `{ ...payload, reason }`; el servidor reclasifica bajo lock.
- Solo ADMINISTRADOR (`@Roles` a nivel de método) y motivo obligatorio (`reasonSchema`).
