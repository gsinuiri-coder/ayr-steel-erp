# cc14 — Autorrevisión de «Editar compra recibida» (D-372, sesión 1)

> **Autorrevisión: lista de riesgos, no aprobación.** Subagente nuevo que no leyó el handoff de
> implementación (AGENTS.md §2.2.1). No vale como pase cruzado ni como revisión independiente.

- Rama: `cc14/editar-compra-recibida` — diff `14db1eb..HEAD` (2 commits: `b9727a9`, `59e1929`).
- Leído: `AGENTS.md`, diseño `ayr-m2b/docs/analisis/m2b-editar-compras-2026-10-02.md` (D-372), el
  diff completo y el código que llama (`InventoryService.record/reverse`, `CoilsService.create`,
  `PurchasesService.receive/cancel`, `purchase-math.ts`, `purchase-draft-edit.ts`,
  `reservation-guard.ts`, `purchase-received-date-fix.ts`).
- No se corrió nada (solo lectura). Las afirmaciones citan código; los escenarios de fallo son
  trazados a mano, no reproducidos.

## Resumen

| Sev. | #    | Hallazgo                                                                                                                                                   |
| ---- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1   | 1    | La reversa intermedia choca con reservas: precio/cantidad de un ítem con reserva (o agregado D-134 comprometido) pasa la vista previa y falla al confirmar |
| P1   | 2    | Producto terminado sin lock del saldo antes de decidir «sin movimientos posteriores»: carrera que puede recostear con consumo ya hecho                     |
| P2   | 3    | `impliedIgvRatePct` se evalúa siempre: una edición solo de cáscara falla en compras con tasa no estándar                                                   |
| P2   | 4    | «Deshacer = volver a editar» no restaura los importes del papel (D-359) ni, por eso, el costo de kardex                                                    |
| P2   | 5    | Cambio de producto deja la compra sin poder anularse si el producto viejo se mueve después                                                                 |
| P2   | 6    | Ítem sin ingreso propio (`ownIn = null`) no bloquea: la línea cambia sin kardex y la vista previa dice «Reversa y nuevo ingreso»                           |
| P2   | 7    | El bloqueo por movimientos posteriores muestra `refType` crudo y fecha, no el documento                                                                    |
| P2   | 8    | Cambio de producto no actualiza `purchaseItem.description`                                                                                                 |
| P3   | 9–20 | Ver abajo                                                                                                                                                  |

## P1

### 1. Reversa intermedia contra reservas y agregado D-134 (vista previa ≠ confirmación)

- `purchase-received-edit.service.ts:477-484` revierte el ingreso **completo** antes de reingresar.
  `InventoryService.reverse` comprueba en ese estado intermedio:
  - `assertReservationInvariant` (`inventory.service.ts:578-583`; `reservation-guard.ts:153-170`):
    `newQty = saldo − qtyIngreso`; si hay reservado por encima, lanza «La operación dejaría … y hay …
    reservados … Anula el pedido o libera la reserva».
  - `assertRawMaterialInvariant` para bobinas (`inventory.service.ts:596-602`): la bobina cae a 0 kg
    y el agregado color/espesor puede quedar por debajo de lo prometido.
- El clasificador solo bloquea la reserva propia en el grupo KARDEX
  (`purchase-received-edit.ts:150`), y nunca mira reservas de producto terminado
  (`service.ts:268`, `ownReservation: false`).
- Consecuencia: un **cambio de precio** (grupo COST) en una bobina con reserva propia, o en una
  bobina cuyo agregado está comprometido, o en un producto con reservas de pedidos, sale en la
  vista previa como `REVERSE_REENTRY` ejecutable y falla al confirmar con un mensaje que pide anular
  el pedido. El diseño (tabla «Qué bloquea cada uso posterior», fila «Reserva activa»: **B1 sí**)
  promete justo ese camino. No corrompe datos (rollback), pero el flujo aprobado no funciona en el
  caso más común de producto en stock y la promesa «lo que se muestra es lo que se hace»
  (`purchase-received-edit.ts:26-28`) no se cumple.
- Cobertura: los tests unitarios simulan `InventoryService` (`purchase-received-edit.service.spec.ts`)
  y el E2E solo usa bobinas sin reservas. Ningún test lo ve.
- Opciones (decisión del dueño): reingresar primero y revertir después (el saldo intermedio
  sube, no baja; revisar que `reverse` siga sacando el valor exacto del original), o clasificar la
  reserva/el agregado en la vista previa y bloquear con mensaje claro.

### 2. Producto terminado: sin lock del saldo antes de leer «movimientos posteriores»

- `commit` toma `FOR UPDATE` de la compra y de sus bobinas (`service.ts:100-108`), pero no del
  saldo de los productos de una compra FINISHED_GOOD. Los movimientos posteriores del producto se
  leen sin lock (`service.ts:246-255`) y el saldo recién se bloquea dentro de `inventory.reverse`
  (`inventory.service.ts:505`). Igual para el producto destino (`service.ts:363-372`).
- El diseño lo pedía explícito: «lock … de los saldos (`lockAvailability`)» (m2b §3, líneas
  111-112).
- Carrera (READ COMMITTED): un despacho concurrente graba un OUT del producto entre la lectura y la
  reversa. La reversa espera el lock, luego sigue con el saldo ya consumido. Ejemplo trazado:
  saldo previo 100 @ 4; ingreso 100 @ 5 → 200, valor 900; despacho 60 @ 4,5 → 140, valor 630;
  reversa 100 por 500 → 40, valor 130, **promedio 3,25** (el real es 4). El reingreso suma sobre
  ese promedio deformado. Es justo el caso «costo con consumo posterior» que la versión 1 bloquea,
  y además el recálculo queda mal.
- Las bobinas sí quedan cubiertas: sus salidas toman el lock de la fila de la bobina
  (`lockRawMaterialCoils` en `record`, `inventory.service.ts:224-226`).

## P2

### 3. `impliedIgvRatePct` se evalúa siempre, incluso sin edición de líneas

- `service.ts:422` calcula `rate` al inicio de `applyItems`, que se llama siempre que hay cambios
  (`service.ts:116`). En una compra cuya tasa implícita no cae en 18 % o 0 % ± 0,1
  (`purchase-draft-edit.ts:60-71`; p. ej. líneas exoneradas mezcladas con gravadas, importes de
  papel), **una edición solo de serie, número u observaciones** lanza «no se recalcula desde acá;
  anúlala y regístrala de nuevo». La vista previa no lo anticipa (no llama a `applyItems`).
- Arreglo obvio: calcular `rate` solo cuando una línea cambia importes.

### 4. Deshacer no restaura los importes del papel (D-359) ni el costo del kardex

- Con cambio de importes, la línea se recalcula como `money(qty × unitario)` e IGV a la tasa
  implícita (`service.ts:452-453`, `editedLineAmounts`). Volver al precio o a la cantidad
  anteriores **no** devuelve el subtotal/IGV del papel ni el ajuste de redondeo que el importador
  absorbió en el IGV de la última línea (`purchase-import-validate.ts:627`). El reingreso usa
  `cents(subtotal × TC)` (`service.ts:486`), así que el costo del kardex y el
  `coil.totalCost/totalCostPen` también pueden quedar a céntimos del original.
- El E2E «volver al valor anterior deja todo como al inicio» (`e2e/.../editar-compra-recibida-d372.spec.ts:147-156`)
  usa una compra con `subtotal = qty × unitario` exacto, así que no lo puede ver.
- Hace falta al menos decirlo en la vista previa/D-372, o conservar los importes del papel cuando
  el valor vuelve al original.

### 5. Cambio de producto deja la compra sin poder anularse

- Tras cambiar el producto, el producto viejo conserva el par ingreso + reversa con
  `refType PURCHASE` y `refId` de la compra (`service.ts:477-485`). `cancel` →
  `assertNothingMovedAfter` mide «posterior» contra el **último movimiento propio por ítem,
  incluidos los revertidos** (`purchases.service.ts:854-861`). Cualquier venta posterior del
  producto viejo —que ya no tiene nada de esta compra— bloquea la anulación de la compra con
  «… ya tiene movimientos posteriores».

### 6. Ítem sin ingreso propio: la línea cambia sin kardex, y la vista previa dice lo contrario

- `applyItems` solo revierte/reingresa si `loadedItem.ownIn` existe (`service.ts:461`); si no,
  actualiza la línea (y en bobinas, `weightKg`/costo de documento si hay `coilId`) sin mover
  kardex. El clasificador no conoce `ownIn` y marca `REVERSE_REENTRY` (`purchase-received-edit.ts:254-256`).
- Casos: producto terminado en línea de negocio NOOP (`record` devuelve `null`, no hay ingreso);
  bobina cuyo primer movimiento vivo no es un IN (`service.ts:207-209`, laterMovements quedaría con
  todo y sí bloquea, salvo que no haya ninguno); línea de bobina sin `coil` (`coilByItem` vacío).
  Para el NOOP es correcto no mover kardex, pero el camino mostrado es falso; para los demás es
  una divergencia línea ↔ kardex silenciosa. Sugerencia: si el ítem debería tener ingreso y no lo
  tiene, bloquear con motivo.

### 7. «Mostrando cuáles» muestra códigos, no documentos

- El motivo arma `${m.refType} el ${m.operationDate}` (`purchase-received-edit.ts:140-143`;
  `service.ts:216-218`): p. ej. «SALES_DISPATCH el 2026-09-20». El diseño pide «La bobina X ya
  tiene producción el …, merma el …» (m2b §3.C) y `cancel` ya resuelve etiquetas
  (`resolveMovementLabels`, `purchases.service.ts:887`). Para el dueño la lista no dice qué
  documento revertir.

### 8. Cambio de producto no actualiza la descripción de la línea

- `service.ts:531-533` conecta el producto nuevo pero deja `purchaseItem.description`
  (`schema.prisma`, `VarChar(240)`) con el nombre del viejo. Lo mismo, más leve, con acabado y
  espesor de una bobina si la descripción los lleva.

## P3

9. **Días de crédito implícitos.** Pasar a CONTADO pone `creditDays = null` (`service.ts:671`) sin
   fila en el plan ni en la auditoría; pasar a CREDITO sin días válidos solo falla al confirmar
   (`service.ts:656-658`), no en la vista previa.
10. **`itemId` duplicado en el cuerpo.** `editReceivedPurchaseSchema` no exige unicidad
    (`packages/shared/src/schemas/purchase.ts`, `items: z.array(...)`). Dos ediciones del mismo
    ítem: la segunda revierte un `ownIn` ya revertido → 409 y rollback (seguro), o se salta y el
    plan mostró otra cosa. Agregar `refine` de unicidad.
11. **Deriva del promedio por redondeo.** En producto con saldo previo > 0, editar y volver deja
    `avgCost` a ±0,0001 del original (el saldo guarda el promedio a 4 decimales,
    `inventory.service.ts:512, 573`). Con saldo previo 0 (bobinas) es exacto.
12. **Producto destino ya usado por otra línea de la misma compra.** Se permite; después las dos
    líneas quedan `sharedProduct` y bloqueadas para siempre (`service.ts:234-242`). Mejor
    bloquearlo en la vista previa.
13. **`productsWithLaterMovements`** cuenta solo `operationDate > recepción` (`service.ts:364-371`):
    no ve movimientos del mismo día grabados después; y se salta si ningún ítem tiene `ownIn`
    (`receiptDate === null`).
14. **Fecha de emisión en USD con TC automático.** Decisión 2 dice no recalcular el TC; está
    respetado, pero la pantalla no avisa que el TC queda el de la fecha vieja. Además la
    herramienta de D-374 usa `issueDate` como fecha destino (`purchase-received-date-fix.ts:88`):
    editar la emisión cambia lo que D-374 haría.
15. **D-374 queda inutilizable tras cualquier edición de kardex**: «La compra ya tiene reversas»
    (`purchase-received-date-fix.ts:98-102`). Orden correcto: corregir la fecha primero. Documentarlo.
16. **Auditoría incompleta del antes/después**: no guarda `dueDate`, `creditDays` implícito, ni el
    costo de documento/`typeKey`/color anteriores de la bobina (`service.ts:118-144`). Tampoco
    hay auditoría por bobina como en `coils.update`/landed cost.
17. **Mensaje de landed cost** cubre cualquier `ADJUST` vivo (`service.ts:222`), incluido el costo
    de corte RF-41 sobre flejes; texto inexacto, bloqueo correcto.
18. **Cambio de proveedor** reescribe `supplierId` de todas las bobinas con ese `purchaseId`,
    incluidas hijas y flejes que heredan el `purchaseId` (`service.ts:646`). Verificar que es lo
    querido.
19. **Web: sin `idempotencyKey`** en la confirmación. El cuerpo es absoluto y la segunda llamada
    ve «sin cambios» bajo el lock, así que es idempotente por naturaleza; dejarlo dicho.
    El doble click está cubierto (`edit-received-purchase-dialog.tsx:756`, `pending`).
    La vista previa queda atada al cuerpo (`payloadKey`, `:254-256`) y la confirmación manda el
    mismo `payload` (`:757`): correcto.
20. **Web: validación local bloquea todo** si la serie/número guardados no cumplen el regex actual
    (`edit-received-purchase-dialog.tsx:182-193`), aunque el usuario solo quiera cambiar otra cosa.
    Pre-existente en el patrón: `reverse` toma el saldo antes que las bobinas del agregado
    (orden inverso a D-134, `inventory.service.ts:505, 601`); no lo introduce este diff.

## Lo que se verificó y está bien

- Todo movimiento pasa por `InventoryService.reverse/record` con la fecha del ingreso original y
  `confirmBackdate` (`service.ts:477-519`); no hay escritura directa a `inventory_balances` ni a
  movimientos.
- Costo de reingreso de bobina = misma cuenta que `CoilsService.create` (`coils.service.ts:157-161,
233-241`): `cents(subtotal × TC)` y unitario derivado; documento de la bobina igual. Producto
  terminado usa `receptionCost` como `receive` (`purchases.service.ts:653`).
- Totales de cabecera = Σ líneas (`purchaseTotalsOf`), coherente con el alta y con el ajuste de
  redondeo del importador absorbido en la última línea.
- Bloqueos presentes: pagos vigentes (contados **después** del lock de la compra, igual que
  `addPayment`, `purchases.service.ts:1259`), `IN_THIRD_PARTY`, anulada, montada en OP, landed
  cost, producto compartido entre líneas, movimientos posteriores (bobina: cualquier vivo distinto
  del ingreso; producto: `id > ingreso` o fecha posterior). Bobina cerrada, vendida entera,
  partida, cortada o con ajuste de cierre dejan un movimiento vivo → bloqueadas.
- D-134 al cambiar acabado/espesor: `assertRawMaterialInvariant` con `alsoAffecting` del agregado
  viejo (`service.ts:593-603`); el ancho no entra al agregado.
- Solo administrador: `@Roles(ADMINISTRADOR)` en ambos endpoints y `assertAdmin` en el servicio.
- Motivo obligatorio: `reasonSchema` (3–240) en el commit; UI con el mismo rango.

## Cobertura de tests contra lo pedido

- Unitarios del clasificador: buenos para la matriz de bloqueos.
- Servicio: base simulada con `InventoryService` falso → no ve #1, #2, #3, #5, #6.
- E2E: solo bobinas (precio, kg, consumo, pantalla, cáscara). Falta: producto terminado (precio y
  cambio de producto), ítem con reserva, cambio de proveedor con bobinas, compra con importes del
  papel (undo), edición solo de cáscara en compra con tasa no estándar, compra SERVICE/EXPENSE.
