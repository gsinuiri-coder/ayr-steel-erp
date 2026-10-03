# D-381 (diseño): autorrevisión — 2026-10-03

> **Autorrevisión.** La hizo un subagente nuevo que no escribió el diseño ni leyó el handoff de la
> sesión. **No es un pase cruzado ni una aprobación**: es una lista de riesgos. La revisión que
> cierra es la del dueño.

Alcance: `git diff origin/main...HEAD` (`90675c0`, solo docs), es decir:

- `docs/analisis/comprobante-a-otro-pedido-2026-10-03.md`;
- la fila D-381 de `docs/ARQUITECTURA.md` §0.2;
- la entrada de `docs/PROGRESO.md`;
- `docs/revision/d381-diseno-segundo-modelo.md`.

Se contrastó con `apps/api/src/invoicing/*`, `apps/api/src/sales/*`, `apps/api/src/reports/*` y
`apps/web/src/components/invoicing/*`. Solo lectura.

**Resultado:** P0 0, P1 1, P2 3, P3 7. Las referencias archivo:línea del diseño que se revisaron
son correctas: `fiscal-import.service.ts:332-336`, `:508-521`, `:636-640` y `:733-746`;
`reactivate-order-lines.ts:67` y `:128`; `invoicing.service.ts:815`, `:1219-1227` y `:1405`;
`sales-orders.service.ts:2197-2350`; las líneas 22-24 y 35-38 de la migración `fase7c`. Ninguna
migración posterior cambia `archive_ck` ni el índice parcial.

## Datos sensibles

**Limpio.** Las líneas añadidas no traen:

- ningún nombre de cliente ni de usuario, ni RUC;
- ningún importe (no hay `S/` ni cifras con decimales de dinero), ni en el análisis, ni en
  PROGRESO, ni en §0.2, ni en el informe del segundo modelo.

Sí quedan el número del comprobante y de los pedidos, los SKU con su cantidad, las fechas y el motivo
«mal ingreso». Es el mismo nivel de detalle de análisis anteriores (p. ej., el de 1382). El JSON de
la foto está en `local-data/`, fuera del diff.

## P1

### P1-1. §4.3 describe mal qué hace «despachar a la fecha del comprobante» con 1389, y el diálogo reutilizado lleva ahí

§4.3 dice que despachar PED-000056 a la fecha 2026-08-20 puede dar el negativo de D-374. Pero el
plan de despacho decide por ítem (`invoice-dispatch-plan.ts:220-260`):

- Si la carga inicial del ítem (su primera entrada `IMPORT`) es **posterior** al 20/08, que es lo
  probable con el día D del 2026-09-07, la línea sale `BEFORE_OPENING`. Se entrega **sin salida de
  kardex** y **se libera la reserva** (`invoice-dispatch-plan.ts:12-14`, `:243`).
- Un ítem sin carga inicial (posiblemente `UPVC6MT`, si entró por compra después del día D) va a la
  comprobación de negativo y termina en `REVIEW`.

Hoy las siete reservas de PED-000056 están `ACTIVE` sobre el stock actual. Si la mercadería sale
físicamente ahora y alguien acepta la fecha sugerida, el kardex se queda con un stock que ya no
existe.

`ReactivateWithOrderLinesDialog` redirige a `?despacho=fecha-comprobante`
(`reactivate-with-order-lines-dialog.tsx:202`), y esa ruta precarga la fecha del comprobante
(`comprobante-detalle-view.tsx:108-110`). Como §3.6 reutiliza ese diálogo, heredaría esa redirección.

**Corrección del diseño:**

- Reescribir §4.3 con las tres salidas: `BEFORE_OPENING`, salida a la fecha del comprobante y
  `REVIEW`.
- Que el paso 5 de §5 pregunte al dueño cuándo salió físicamente la mercadería de 1389.
- Decidir si la acción nueva redirige **sin** `?despacho=fecha-comprobante`.

## P2

### P2-1. Si el papel es por seis líneas, el diseño no tiene salida

§1.4 deja abierta la posibilidad de que el papel vigente sea por las seis líneas. Pero §3.1 (paso 3)
siempre factura **el pedido entero**, así que el total de siete no coincide y la acción se rechaza.
Tampoco se puede quitar la línea `UPVC6MT` de PED-000056: una línea de pedido no se borra (H7,
`reactivate-order-lines.ts:24-25`).

En ese caso, 1389 vuelve a quedar sin camino. Haría falta un modo «solo remapear las filas del
papel», sin agregar las líneas libres del destino. `UPVC6MT` se facturaría aparte.

**Recomendación:** pedir la respuesta de §1.4 **antes** de implementar, o diseñar los dos modos.
El modo de solo remapeo es un subconjunto de `pairRowsToOrder` en el que el paso 4 no corre.

### P2-2. Anular un pedido con un comprobante vivo está permitido, y eso reproduce el caso

`cancel` (`sales-orders.service.ts:2197-2350`) no comprueba si el pedido tiene comprobantes vivos.
Solo bloquea `FULFILLED` y las OP en curso. Por eso PED-000044 pudo anularse 17 s antes que 1389.

Después de mover 1389, nada impide anular PED-000056 con el comprobante `ACCEPTED`. Si eso pasa:

- `buildPlan` deja de ver el comprobante (`invoice-dispatch.service.ts:489`,
  `salesOrder.status != CANCELLED`);
- el comprobante sigue vivo en cuentas por cobrar.

**Fuera del alcance de D-381**, pero es la causa de raíz. Conviene que el dueño decida aparte
(nueva `D-nnn`) si anular un pedido con un comprobante vivo debe bloquear.

### P2-3. Invalidación y navegación en la web: son dos pedidos, no uno

El diálogo de D-378 invalida solo `orderId: d.salesOrderId`
(`reactivate-with-order-lines-dialog.tsx:197-201`). La acción nueva tiene que invalidar:

- el pedido de origen, porque desaparece su `AnnulledDocumentsCard` y cambia su conteo;
- el de destino;
- las listas de comprobantes y de cuentas por cobrar.

`d.salesOrderId` del candidato todavía es el del origen cuando se abre el diálogo. Si se reutiliza
el diálogo sin cambios, refresca el pedido equivocado.

## P3

1. **Notas de crédito no vivas.** `lockAnnulledForReactivation` deja pasar una NC anulada o
   rechazada que se creó antes de la anulación (`fiscal-import.service.ts:1059-1069`). Esa NC
   conserva `sales_order_id` del origen y sus ítems apuntan a líneas del origen, con
   `affected_item_id` hacia las filas movidas. No afecta a los reportes, que leen solo las vivas
   (`sales-by-material.service.ts:120-125`, filtro `LIVE`), pero deja un enlace cruzado entre
   pedidos. Por la misma prudencia que con el despacho `REVERSED` de §3.3, bloquear si existe
   cualquier NC sobre el comprobante. En 1389 hay 0.
2. **Tope de candidatos.** §3.6 limita a «los últimos 20 anulados del cliente». El filtro «pedido de
   origen anulado» tiene que ir en la consulta **antes** del `LIMIT`; si no, un candidato válido
   puede quedar fuera. Con unos 17 SQL por candidato, 20 candidatos son más de 340 consultas.
   Conviene la alternativa del segundo modelo: devolver solo la identidad y calcular el motivo en la
   vista previa.
3. **Alcance por vendedor, con más precisión.** El listado de comprobantes también filtra por
   `createdById` (`fiscal-document-where.ts:23-25`): quien registró el manual lo sigue viendo. Lo
   que cambia es:
   - el cobro, que mira el vendedor del pedido y usa `createdById` solo si no hay pedido
     (`receivables.service.ts:120-123`);
   - el despacho por comprobante (`invoice-dispatch.service.ts:167`, `:327`);
   - el margen (`sales-margin.service.ts:122`).

   Conviene que el texto del modal hable de «cobro y reportes», no de «visibilidad».

4. **Reportes de un período pasado.** Al volver a `ACCEPTED` con siete líneas, «Ventas por
   material» y el margen de agosto (filtran por `fd.issue_date`, `sales-margin.service.ts:126-127`)
   suben con las siete líneas, incluida `UPVC6MT`. Es coherente con el papel y con D-373/D-378,
   pero conviene decirlo en el modal o en el UAT si agosto ya se reportó.
5. **Interfaz y etiquetas que faltan en el diseño:**
   - `apps/web/src/lib/audit-labels.ts:58` necesita las tres acciones nuevas
     (`invoicing.document.move-to-order`, `sales.order.document-moved-out` y
     `sales.order.document-moved-in`);
   - el menú de la fila en Comprobantes → Anulados (`comprobantes-view.tsx:432`) también ofrece D-378
     y debería mostrar el mismo aviso que §3.6 pone en el detalle.
6. **Fila D-381 de §0.2.** No menciona el requisito P1 del segundo modelo (que `updates` escriba
   `salesOrderItemId`) ni que el destino queda congelado por D-187. El análisis sí los tiene.
   Además, el bloqueo «el destino es el mismo pedido de origen» de §3.3 es redundante: un origen
   `CANCELLED` y un destino no `CANCELLED` nunca son el mismo pedido. No hace daño.
7. **Doble envío.** El `POST` no lleva `idempotencyKey` (AGENTS §3.4). Como en D-373 y D-378, lo cubre
   la transición de estado: el segundo intento ve `ACCEPTED` y recibe 409 «ya está vigente»
   (`fiscal-import.service.ts:1000-1002`). Aceptable, pero el diseño debería decirlo.

## Lo que se verificó y está bien

- **Carreras.** El orden comprobante → pedidos (ordenados por id) → borradores no forma ciclo con
  ningún camino actual:
  - registrar o emitir un borrador bloquea solo su fila (`invoicing.service.ts:1179`);
  - crear un comprobante toma el pedido (`:497`);
  - editar un pedido toma el pedido y lee los comprobantes sin lock
    (`sales-order-edits.service.ts:889-911`);
  - el despacho toma pedido → bobinas.

  Dos «traer» cruzados hacia el mismo destino se serializan en el pedido destino, y el segundo
  choca con `onOrder`.

- **`invoicedByOrderItem` y `assertStillAvailable`.** Con el P1 del segundo modelo corregido (que
  `updates` escriba `salesOrderItemId`), lo facturado se agrupa por las líneas del destino. Un
  borrador que se registre en paralelo, al revalidar, ve esas líneas facturadas y se rechaza.
- **Despacho por comprobante.** `createInTx` arma el despacho con `salesOrderId` del comprobante y
  con los `salesOrderItemId` de sus filas (`invoice-dispatch.service.ts:344-387`). Sin el P1 del
  segundo modelo quedaría un despacho del destino con líneas del origen. Con el P1, es coherente.
- **Cuentas por cobrar.** El cobro va por `documentId` (`CustomerPayment`, sin `sales_order_id`), y
  el cliente no cambia. La deuda reaparece por el total nuevo, con el vencimiento del papel.
- **Sin migración.** Es cierto. No hay límite de crédito que se saltee: no existe `creditLimit`.
