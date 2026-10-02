# M2b: editar compras ya recibidas (D-372), diseño

> **Solo diseño.** No hay código ni migración. La foto de producción es del 2026-10-02, en una
> transacción `READ ONLY` con OK del dueño; solo cuenta filas (sin proveedores ni importes) y el
> script se borró después de correrlo. El código citado es `main` en `14db1eb`.

## 0. Resumen

- **No hay un clasificador de cc06 para esto.** D-371 solo edita borradores, y la compra recibida
  lo rechaza explícitamente. En el código hay dos clasificadores que se pueden reusar como patrón:
  `classifyReceivedDate` (la herramienta de fechas) y `classifyCoilRestore` (D-375).
- **El costo de lo vendido queda fijo en cada salida.** El margen de ventas, la rentabilidad por
  comprobante y la producción suman el `total_cost` que grabó la salida. Corregir el costo de una
  compra **no cambia márgenes históricos**; solo cambia el promedio de lo que queda. La excepción es
  el reporte PEPS, que recalcula al leer.
- **Propuesta en tres niveles:**
  - **Cáscara:** se edita en el lugar y se audita.
  - **Costo:** si nada se movió después, reversa y reingreso en la misma fecha (el patrón del
    recosteo, D-045). Si ya hubo consumo, un ajuste por la diferencia sobre el saldo que queda (el
    patrón del landed cost, D-043), con aviso de lo ya vendido.
  - **Kardex** (cantidad, producto, especificación de la bobina): solo si el ítem no tuvo **ningún**
    movimiento posterior. Si lo tuvo, se bloquea con el detalle de qué lo movió.
- **Foto de producción:** 18 compras recibidas, todas en soles, sin pagos y sin landed cost.
  - **8** no tienen ningún consumo posterior.
  - **10** sí: 6 con producción y 4 con venta.
- **Estimación:** 2 sesiones de implementación más revisión y ventana. Si el ajuste con consumo
  (B2) se deja para después, alcanza con 1.

## 1. Qué quedó decidido y qué quedó abierto

**D-371 (cc06, desplegada) edita solo borradores.**

- `PATCH`/`DELETE /purchases/:id/items/:itemId`, solo administrador. Edita cantidad y costo
  unitario; no agrega líneas.
- `assertDraftEditable` (`purchases/purchase-draft-edit.ts:22`) exige `DRAFT` y cero pagos
  vigentes. Con la compra recibida responde «La compra ya está recibida: sus líneas movieron kardex
  y no se editan desde acá».
- La tasa de IGV no se guarda: se deduce de los totales (`impliedIgvRatePct`, :57) y se ajusta a 18
  o 0.
- `receive` relee las líneas después de su claim (`purchases.service.ts:599-606`).

**D-372 (backlog)** pide diseñar la compra recibida con reversas: kardex append-only, todo por
`InventoryService.record()` (regla dura 8) y la invariante D-150/D-206 (heredar los servicios
reales; la bobina se crea solo con `CoilsService.create`).

**Lo único que ya se edita sobre una recibida:**

- `updateDocument` (`purchases.service.ts:334`): serie y número;
- la herramienta de fechas de recepción (CLI `fix:purchase-received-dates`, D-374). Su punto 3
  —aceptar una salida posterior cuando el costo no cambia— sigue pendiente.

**Precedentes del patrón «corregir una entrada»:**

| Operación                     | Mecanismo                                                                                            | Cuándo se bloquea                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Recosteo de bobina (D-045)    | reversa del IN y nuevo IN, **en la fecha original** (`coil-operations.service.ts:961-1012`)          | si el IN inicial no es el único movimiento vivo (`initialMovement`)        |
| Herramienta de fechas (D-374) | nuevo IN en la fecha destino y reversa del viejo (`purchase-received-date-fix.ts:223-308`), con undo | salida o ajuste posterior, `IMPORT` en el rango, saldo intermedio negativo |
| Restaurar bobina (D-375)      | nuevo IN con el costo del revertido (`coil-restore.ts`)                                              | salidas vivas, ajustes, reservas, hijos                                    |
| Landed cost (D-043)           | `adjustCost` (ADJUST) sobre las bobinas con saldo (`purchases.service.ts:916-1044`)                  | solo imputa a lo que queda; lo consumido no se toca                        |

## 2. Los campos, en tres grupos

### A. Cáscara: no mueven kardex ni costo

| Campo                                     | Dónde se lee                                                                                | Nota                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `series`, `number`, `docType`             | identificación; único parcial `WHERE status <> 'CANCELLED'` (`schema.prisma:988-994`)       | serie y número **ya** se editan (`updateDocument`)                                     |
| `issueDate`                               | `dueDate`; el TC automático sale de esa fecha (`rateFor`, `purchases.service.ts:1636-1645`) | **solo cáscara si el TC no se recalcula.** En USD con TC automático pasaría al grupo B |
| `paymentTerms`, `creditDays`, `dueDate`   | cuentas por pagar (`purchaseBalance`, `purchase-math.ts:122`)                               | sin kardex                                                                             |
| `notes`, `sourceXmlKey`                   | presentación                                                                                |                                                                                        |
| `description`, `externalCode` de la línea | presentación y trazabilidad                                                                 |                                                                                        |
| `supplierId`                              | cuentas por pagar, unicidad del comprobante; la bobina guarda su proveedor (vía la compra)  | sin kardex, pero cambia de quién es la deuda: **bloquear con pagos**                   |

### B. Afecta el costo, no las cantidades

| Campo                                 | Efecto                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unitPrice`, `subtotal` (línea)       | `CoilsService.create`: `totalCost = item.subtotal` y `kardexTotalPen = cents(subtotal × rate)` (`coils.service.ts:160`); FINISHED_GOOD: `receptionCost` (`purchase-math.ts:166`)            |
| `exchangeRate`                        | lo mismo que el precio, para todas las líneas; además `coil.exchangeRate` y `bumpCoilDocumentCost` (:1191)                                                                                  |
| `currency`                            | cambia la base del costo y de los pagos. Se trata como precio + TC                                                                                                                          |
| `igv`, `total`, `totalPen` (cabecera) | derivados. El IGV nunca entra al costo (D-038); solo cuentas por pagar                                                                                                                      |
| Costo de documento de la bobina       | `coil.unitCostPerKg`, `totalCost`, `totalCostPen`: plan de cierre (`coil-operations.service.ts:729`), flejes de corte (`cutting.service.ts:311`), reporte mensual (`reports.service.ts:88`) |

### C. Afecta el kardex

| Campo                                                      | Efecto                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qty` (kg de la bobina, unidades del producto)             | cantidad del IN; `coil.weightKg` es el techo del cierre (`coil-operations.service.ts:715`); el **código de la bobina lleva el peso** (`coils.service.ts:171-177`) |
| `productId` (FINISHED_GOOD)                                | qué ítem del kardex recibió la entrada                                                                                                                            |
| `finishId`, `colorId`, `widthMm`, `thicknessMm` (bobina)   | identidad de la bobina: agregado de materia prima (reservas D-134), corte y producción                                                                            |
| `coilStatus` inicial                                       | si nació cerrada                                                                                                                                                  |
| Fecha de recepción (`receivedAt` y `operationDate` del IN) | dónde cae la entrada en el kardex. Ya la cubre la herramienta de D-374                                                                                            |
| Agregar o quitar líneas                                    | un IN nuevo o la reversa de uno                                                                                                                                   |

## 3. Cómo se edita cada grupo

Reglas comunes:

- solo administrador, con motivo obligatorio;
- una transacción con lock de la compra (`FOR UPDATE`), de las bobinas (`coils`, en orden de id) y
  de los saldos (`lockAvailability`);
- auditoría `purchases.update-received` con el antes y el después de cada campo y los ids de los
  movimientos revertidos y nuevos;
- todo movimiento pasa por `InventoryService.record`/`reverse`/`adjustCost`;
- la reversa (deshacer la edición) se construye en la misma fase, con el patrón `--undo` de la
  herramienta de fechas.

### A. Cáscara: se edita en el lugar

- Es un `update` de la fila, auditado. No genera movimientos.
- **Bloqueos:**
  - el comprobante duplicado (el mismo índice de hoy);
  - cambiar el **proveedor** con pagos vigentes;
  - cambiar `issueDate` en una compra USD con TC automático: o se rechaza, o pasa por el grupo B
    (decisión 2).
- **Reversa:** es otra edición con los valores de antes, desde la auditoría.

### B. Costo: dos caminos según si hubo movimientos después

1. **B1, sin movimientos posteriores sobre el ítem** (`classifyCostEdit` = el criterio de
   `initialMovement`/`assertNothingMovedAfter`: el IN de la compra es el último movimiento vivo):
   - reversa del IN de recepción y **nuevo IN en la misma fecha** con el costo corregido, con
     `confirmBackdate`. Es el recosteo de D-045 generalizado a la compra;
   - se actualizan la línea, la cabecera (`purchaseTotalsOf`) y el costo de documento de la bobina;
   - el kardex queda como si la compra hubiera entrado bien.
2. **B2, con consumo posterior** (producción, merma, venta, partido, corte):
   - **no se reescriben las salidas pasadas** (append-only, regla 8);
   - se graba un **ajuste por la diferencia** sobre lo que queda de ese ítem (`adjustCost`, la
     mecánica del landed cost), con `refType PURCHASE` a la compra corregida y nota «corrección de
     costo»;
   - si el ítem ya no tiene saldo, no hay dónde imputarlo: la diferencia queda solo en el documento
     (la compra y la bobina) y se avisa (decisión 3).
   - **Aviso:** antes de confirmar se listan los despachos y OP que se llevaron material de esa
     bobina o producto a otro costo. Sus márgenes **no se recalculan**.
3. **Bloqueos de B:**
   - pagos vigentes, si el total nuevo queda por debajo de lo pagado (o con cualquier pago, como
     D-371: decisión 4);
   - bobina en corte (`IN_THIRD_PARTY`);
   - landed cost aplicado: el ajuste del flete también se recalcularía (no hay ninguno en
     producción; se bloquea y se decide si aparece).

### C. Kardex: solo si el ítem está intacto

- **Condición:** el IN de esa línea es el **único movimiento vivo** del ítem (bobina) o el último
  (producto); no hay reservas activas, OP con la bobina montada, partidos, cortes, cierre ni
  ajustes. Son las guardas de §5 del inventario: `initialMovement`, `assertStripsNotAssigned`,
  `assertNotReserved`, estado de la bobina, `splitId`.
- **Mecanismo:**
  - reversa del IN y nuevo IN con la cantidad, el producto o la especificación corregidos, **en la
    fecha de recepción original**;
  - en una bobina se actualizan `weightKg`, la especificación y el costo de documento con la misma
    cuenta de `CoilsService.create`, sin crear una bobina nueva (conserva el id);
  - en un producto distinto, la reversa sale del ítem viejo y el IN entra al nuevo.
- **Con cualquier movimiento posterior se bloquea**, con el detalle: «La bobina X ya tiene
  producción el …, merma el …: revierte esas operaciones primero o anula la compra». No hay un B2 para
  cantidades: un ajuste de cantidad sobre lo ya consumido inventaría o borraría material.
- **Agregar o quitar líneas:** propongo dejarlo **fuera de la primera versión** (decisión 6). Con
  todo intacto, hoy ya se puede anular la compra y registrarla de nuevo.
- **Fecha de recepción:** sigue siendo de la herramienta de D-374 (CLI). M2b no la duplica.

### Qué bloquea cada uso posterior

| Uso posterior del ítem                            | A (cáscara)   | B (costo)                              | C (kardex)          |
| ------------------------------------------------- | ------------- | -------------------------------------- | ------------------- |
| Ninguno                                           | se edita      | B1 (reversa y reingreso)               | se edita            |
| Reserva activa                                    | se edita      | B1 si no hay salidas                   | bloqueado           |
| Montada en OP / en corte (`IN_THIRD_PARTY`)       | se edita      | bloqueado                              | bloqueado           |
| Producción, merma, partido, venta (salidas vivas) | se edita      | B2 (ajuste sobre lo que queda + aviso) | bloqueado           |
| Bobina cerrada (ajuste de cierre)                 | se edita      | B2; sin saldo, solo documento          | bloqueado           |
| Pagos vigentes                                    | sin proveedor | según la decisión 4                    | según la decisión 4 |
| Landed cost aplicado                              | se edita      | bloqueado                              | bloqueado           |

## 4. Efecto sobre lo ya vendido

Medido en el código (inventario §4):

- Una salida `OUT` graba `unitCost = avgCost` del momento (`inventory.service.ts:271-272`). El margen
  de ventas (`sales-margin.service.ts:221-245`), la rentabilidad por comprobante
  (`document-profitability.service.ts:96-117`) y el costo de producción
  (`roofing-production.service.ts:1240-1247`) suman ese `total_cost`. **Son fotos.**
- El **PEPS** (`kardex-peps.service.ts:118-172`) recalcula al leer desde los IN. Un reingreso con otro
  costo o un ajuste cambia sus filas históricas.
- El **inventario valorizado** sale del saldo actual (`qty × avgCost`) y refleja la corrección al
  instante.

**Propuesta: se deja y se avisa.** No se recalcula ningún margen:

- es coherente con D-377 («solo hacia adelante») y con el kardex append-only;
- recalcular obligaría a reescribir los `total_cost` de las salidas o a mantener una segunda vía de
  costo que divergiría del kardex;
- el aviso del paso B2 lista los documentos afectados, para que el dueño sepa qué márgenes quedaron
  con el costo viejo;
- el PEPS cambia, y se dice en la auditoría y en la nota del ajuste.

**Medición en producción (2026-10-02, `READ ONLY`):**

| Qué                                    | Cuántas                                        |
| -------------------------------------- | ---------------------------------------------- |
| Compras `RECEIVED`                     | **18** (9 de bobinas, 9 de producto terminado) |
| `CANCELLED`                            | 3 (bobinas)                                    |
| En USD                                 | 0                                              |
| Con pagos                              | 0                                              |
| Con landed cost / servicios vinculados | 0 / 0                                          |
| Movimientos de recepción vivos / ítems | 82 / 79                                        |
| **Sin ningún consumo posterior**       | **8**                                          |
| **Con consumo posterior**              | **10** (bobinas 6 de 9, producto 4 de 9)       |
| … con producción                       | 6                                              |
| … con venta                            | 4                                              |
| Ítems con salidas, por tipo            | producción 32, merma 10, venta 2               |
| Bobinas recibidas                      | 69 (46 abiertas, 23 cerradas)                  |

**Lectura:**

- Con B1 y C (sin consumo) se corrigen hoy 8 de 18 compras enteras.
- Para las otras 10 solo queda la cáscara, o el costo por B2.
- El impacto en márgenes ya reportados es acotado: 2 ítems con venta, y lo vendido no cambia de
  costo por la propuesta.
- No hay USD, pagos ni landed cost: los bloqueos por esas causas no afectan a ninguna compra actual.

## 5. Decisiones que necesito

| #   | Decisión                                                  | Recomendación                                                                                                                             |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Qué campos de cáscara se editan                           | Serie y número (ya), tipo de documento, fecha de emisión, condiciones de pago, observaciones y descripción. **Proveedor solo sin pagos.** |
| 2   | Cambiar la fecha de emisión en USD con TC automático      | **No recalcula el TC**: el TC se corrige aparte, por el grupo B. Hoy no hay compras en USD                                                |
| 3   | Costo con consumo posterior (B2)                          | **Ajuste por la diferencia sobre lo que queda y aviso de lo vendido; sin recalcular márgenes.** Sin saldo, solo se corrige el documento   |
| 4   | Ediciones con pagos vigentes                              | **Bloquear las de costo y kardex con cualquier pago vigente**, como D-371 (hoy no hay pagos); la cáscara sí                               |
| 5   | El código de la bobina cuando cambia el peso              | **Conservar el código** (es la etiqueta física y la clave que usa todo el resto); el peso nuevo queda en la ficha y en la auditoría       |
| 6   | Agregar o quitar líneas de una recibida                   | **Fuera de la primera versión**; con todo intacto se anula y se registra de nuevo                                                         |
| 7   | Cantidad, producto o especificación con consumo posterior | **Bloquear** con el detalle de qué movió el ítem; no hay ajuste de cantidades                                                             |
| 8   | Fecha de recepción                                        | Queda en la herramienta de D-374; M2b no la toca                                                                                          |
| 9   | Interfaz                                                  | «Editar compra» en el detalle de la recibida, con la vista previa de qué camino toma (A, B1, B2 o bloqueo) y los documentos afectados     |
| 10  | Reversa de la edición                                     | `--undo` por lote, como la herramienta de fechas: se niega si hubo movimientos después de la edición                                      |

## 6. Estimación

| Sesión | Alcance                                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1      | A (cáscara) + B1 + C con el clasificador (`classifyPurchaseEdit`), API, interfaz, auditoría, reversa, unitarios y E2E                                     |
| 2      | B2 (ajuste sobre lo que queda) con el aviso de documentos afectados, más los bordes de bobina cerrada y producto                                          |
| —      | Revisiones (autorrevisión + Sonnet) y ventana. **Sin migración** si se aprueban las recomendaciones (todo cabe en las columnas actuales y en `audit_log`) |

Sin B2 alcanza con una sesión, y cubre 8 de 18 compras enteras más la cáscara de todas.
