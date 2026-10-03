# Revisión del diseño D-381 (segundo modelo, contexto limpio) — 2026-10-03

Alcance: `docs/analisis/comprobante-a-otro-pedido-2026-10-03.md` y la fila D-381 de `docs/ARQUITECTURA.md` §0.2,
contrastados con `fiscal-import.service.ts`, `reactivate-order-lines.ts`, `invoicing.service.ts`,
`sales-orders.service.ts`, `order-documents.ts`, las migraciones y el web. Solo lectura. Es un segundo modelo,
no una aprobación.

**Veredicto:** sin P0. El diseño es implementable y coherente con D-373/D-378/D-077. Hay un P1 de implementación
(el `update` de D-378 no escribe `salesOrderItemId`, y todo el diseño depende de eso) y varios P2.

## Verificación de las afirmaciones

1. **§2 (no hay camino hoy): correcta.**
   - `invoicing.service.ts:1219-1227`: el choque busca por `number` y `archivedAt: null` sin estado. Correcto.
   - Migración `fase7c_comprobantes_importados`: índice `:24`, `archive_ck` `:35-38`. Correcto.
   - `fiscal-import.service.ts:332-336` y `:636-640`: ambos 409 por pedido anulado. Correcto.
   - `sales-orders.service.ts` `cancel` 2197-2350, y no existe reabrir pedido (solo dos escrituras de `CANCELLED`, :2303 y :2340). Correcto.
   - Nadie escribe `fiscal_documents.sales_order_id` tras `createInTx` (grep sin resultados). Correcto.
   - Desfase menor: «Un comprobante anulado ya no se corrige» está en `invoicing.service.ts:1405`, no 1404 (P3).
2. **§5 «sin migración»: cierto.** Ningún CHECK mira `sales_order_id` ni `sales_order_item_id`.
   - `shape_ck` solo ata `dispatch_id` y doc_type.
   - `annulled_trace_ck` (bicondicional), `annul_shape_ck` y `annulled_origin_ck` se cumplen al volver a `ACCEPTED` y limpiar `annul*`, igual que D-373.
   - `number_ck` y el índice parcial no se tocan porque el número no cambia.
   - La FK `fiscal_document_items_sales_order_item_id_fkey` no es única: dos filas pueden apuntar a la misma línea, pero el diseño ya impide duplicados por construcción.

## Hallazgos

### P1-1. `planOrderLines` no escribe `salesOrderItemId` en los `updates`; el remapeo no persiste

`reactivate-order-lines.ts:67` define `updates` sin `salesOrderItemId`, y la escritura de D-378
(`fiscal-import.service.ts:508-521`) tampoco lo pone en `data`. Solo los `creates` lo traen.
Si se pasa a `planOrderLines` la lista remapeada tal como dice §3.4 y se reutiliza la escritura de D-378,
las 6 filas pasan al pedido destino (`sales_order_id`) pero **siguen apuntando a las líneas de PED-000044**.
Eso rompe `invoicedByOrderItem`, el despacho por comprobante (D-364), los reportes por producto y el propio
bloqueo «otra factura viva» sobre PED-000056.
Corrección de diseño: el plan (o la escritura) debe llevar `salesOrderItemId` en los `updates`, y un
unitario debe probar que, tras ejecutar, ninguna fila apunta a líneas del origen. El §3.5 dice «un `update` por
fila»; hay que decir qué campos, incluido este.

### P2-1. Con el remapeo, el «antes» y el `rows` de auditoría pierden la trazabilidad al pedido origen

`planOrderLines` calcula `before.orderLineNumber` con `orderById.get(d.salesOrderItemId)` (:142). Con filas ya
remapeadas, el «antes» muestra los números de línea del **destino**, no los de PED-000044. El
`before.rows` de D-378 (`fiscal-import.service.ts:545-549`) guarda `id/lineNumber/productId` pero no el
`salesOrderItemId` original; después de mover se pierde para siempre a qué línea del origen apuntaba cada fila.
Corrección: guardar en `before.rows` el `salesOrderItemId` y el número de línea de origen (se lee antes de
remapear), y que el «antes» del modal use los números de origen.

### P2-2. El emparejado por producto puede cruzar líneas del mismo producto

§3.4 paso 1 empareja por producto «en orden». Si el producto se repite con cantidades o precios distintos, el
orden puede cruzar líneas y el control del total del papel **no lo detecta** (se conserva la suma). Como
`planOrderLines` conserva descripción y unidad de la fila y toma cantidad e importes del pedido, el papel
quedaría con la descripción de una línea y los importes de otra. Sugerencia: dentro del mismo producto, preferir
primero la pareja con misma cantidad y mismo unitario, y recién después el orden. Y que el modal marque las
parejas que no coinciden en cantidad o precio.

### P2-3. El paso 2 (cambio de producto por orden) es una pareja silenciosa

Una fila sobrante se empareja con cualquier línea libre del destino aunque sea otro producto, y
`planOrderLines` reescribe producto y descripción (`:170-174`). Es la única vía por la que un papel puede pasar
a describir otra mercadería. El total tipeado protege el dinero, no la mercadería. Recomiendo que el modal
resalte esas filas («cambia de producto») y que el motivo/casilla las nombre; o bloquear el paso 2 y exigir
que cada fila tenga un producto igual (con 1389 no se usa).

### P2-4. D-187 sobre el pedido destino: efecto no declarado

Tras el movimiento, PED-000056 tiene una FACTURA `ACCEPTED`, así que `isEditable` pasa a `false`
(`sales-orders.service.ts:3187`, `STANDING_DOCUMENT_STATUSES`, D-187) y precio/cliente/ítems/cantidades quedan
congelados. Es lo esperado y D-378 también lo hace, pero el diseño no lo dice y conviene avisarlo en el modal:
el destino deja de ser editable. Además, el destino tiene reservas `ACTIVE` y puede tener OP: bloquear
ediciones **después** es correcto, pero debe verificarse que el destino no tenga ediciones en vuelo — el
`FOR UPDATE` del pedido (que las ediciones también toman, `sales-order-edits.service.ts:889`) lo cubre.

### P2-5. Vendedor y alcance por vendedor

El alcance del comprobante sale del vendedor del pedido (`invoice-dispatch.service.ts:167`,
`invoicing.service.ts:947/1565/1635`, `receivables.service.ts`, `sales-margin.service.ts`). Mover el
comprobante cambia de golpe quién lo ve (un VENDEDOR pierde acceso al comprobante y a sus cuentas por cobrar)
y a quién se atribuye la venta. §1.4 lo cubre para los reportes pero no para visibilidad y cobranza. Debe
decir que la acción es solo administrador (ya lo dice) y que el modal muestra el cambio de vendedor
(origen → destino) como advertencia, no solo «si cambian».

### P2-6. La lista de candidatos no está acotada

`GET …/movable-annulled-documents` corre, por candidato, las comprobaciones de D-378 con `lock = false`
(`annulledOfOrder`, `fiscal-import.service.ts:211-291`, ~17 SQL por anulado medidos en D-378). Los candidatos
son «manuales anulados del mismo cliente con pedido anulado»: un cliente con muchos puede costar decenas de
consultas por abrir el diálogo. Pedir un presupuesto de consultas verificado por test (regla de `AGENTS.md`
§3.4) y un tope de candidatos (por ejemplo, los 20 más recientes), o devolver solo identidad y calcular el
motivo al elegir.

### P3-1. `annulledDocumentCount`

El conteo de anulados del pedido sale de `orderDocuments` (`order-documents.ts`, `sales-orders.service.ts:3188`)
y es por `sales_order_id`. Tras mover, el origen queda con 0 anulados y desaparece su tarjeta
`AnnulledDocumentsCard`; el destino lo ve **vivo**. No hay inconsistencia, pero el botón «Traer comprobante
anulado» del destino no puede apoyarse en ese contador (cuenta los del propio pedido): requiere su propia
consulta cuando se abre el diálogo, o un contador nuevo. Decir cuál (el §3.6 deja ambas abiertas). Las dos
auditorías de pedido son lo que deja rastro en el origen: me parece correcto mantenerlas.

### P3-2. Número de línea del comprobante vs. del pedido

El `UPVC6MT` entra como línea 7 del papel y no como línea 1 del pedido. Es el mismo comportamiento de D-378,
pero el diseño lo declara bien; solo añadir que `lineNumber` del comprobante y `orderLineNumber` del «después»
deben seguir distintos en el modal.

### P3-3. Referencia de línea

`invoicing.service.ts:1404` → `1405`.

## Preguntas del encargo

- **¿Funciona `planOrderLines` con filas remapeadas?** Sí, salvo P1-1. Con ids remapeados, `byOrderItem`,
  `updates`, `creates` y `changed` se comportan como D-378. Cambio de producto: toma producto, descripción y
  unidad del pedido (`:170-174`). Filas en su lugar: conserva id y número de línea. Creates: se agregan al
  final con `salesOrderItemId` ya puesto. Lo que no hace es **escribir** el id remapeado en las filas existentes
  (P1-1). Aquí `changed` no se usa y hay que decirlo en la implementación.
- **`invoicedByOrderItem` / `assertLinesNotReinvoiced`:** el chequeo «otro comprobante vivo o borrador en el
  destino» de D-378 (`onOrder`, `:689-694`: por `salesOrderId` **o** por líneas) ya cubre el refacturado de
  líneas destino por otro documento, así que no hace falta añadir `assertLinesNotReinvoiced`; sí debe
  ejecutarse con los ids del **destino**, no con los del origen. `checkReactivateExternal` /
  `assertOrderLinesUnchanged` no aplican (otra orden).
- **Despachos con `invoice_id`:** bloqueo propuesto correcto y suficiente (`invoice-dispatch.service.ts:208`
  filtra por `invoiceId` y `ISSUED`). El pendiente se cuenta por línea de pedido; con las filas apuntando al
  destino (tras P1-1) queda coherente.
- **CHECKs y cuentas por cobrar:** sin impacto. El cliente no cambia, así que la deuda del cliente sale igual
  (vuelve a figurar al pasar a `ACCEPTED`, como D-373).
- **Orden de locks:** seguro. comprobante → pedidos por id → borradores. Las rutas existentes toman:
  borrador (registrar/enviar) solo su fila y sin pedido; creación de borrador, el pedido primero y luego
  inserta (no bloquea filas viejas); cancelar pedido, el pedido y sus reservas sin tocar comprobantes;
  despacho, pedido → bobinas. Nadie toma borrador → pedido, así que no hay ciclo. Las dos reactivaciones ya
  toman comprobante → pedido → borradores, y el comprobante primero las serializa entre sí.

## Coherencia de §4 con las decisiones previas

- **Mismo cliente (4.1):** coherente con D-378 (cliente distinto bloquea) y con D-077 (la boleta a «público en
  general» no cambia de cliente; el tope solo se revisa si cruza).
- **Origen anulado (4.2):** coherente con D-373 (pedido `CANCELLED` bloquea) y con D-378 (si el pedido está vivo,
  se corrige y se reactiva).
- **Fecha (4.3):** coherente; ninguna regla compara fecha de comprobante y de pedido (D-364/D-278 se aplican al despachar).
- **Fila D-381 de §0.2:** coherente con el análisis (bloqueos, auditoría, «sin migración»). Falta mencionar
  P1-1 como requisito y que el pedido destino queda congelado por D-187.

## Resumen

P0: 0. P1: 1 (escritura de `salesOrderItemId` en `updates`). P2: 6. P3: 3.
