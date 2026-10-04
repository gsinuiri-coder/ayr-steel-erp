# D-383 — proteger la anulación de un pedido: **autorrevisión**

> **Autorrevisión** (AGENTS.md §2.2.1): subagente nuevo que no escribió el código ni leyó el
> handoff de implementación. Es una lista de riesgos, **no una aprobación** ni un pase cruzado.

- Rama: `d383/proteger-anular-pedido` (PR #90). Diff revisado: `git diff origin/main...HEAD` en
  `f4e120f`.
- Mientras revisaba, el árbol de trabajo tenía cambios sin commitear (los borradores bloquean la
  anulación, céntimos en el criterio de NC, lock de borradores por línea, purga de borradores en
  `purgeInvoicingTrail`, spec E2E reescrito). Los hallazgos citan HEAD salvo donde dice **[WIP]**.
- Corrido: `jest src/sales src/invoicing src/pos` → 69 suites, 907 tests verdes; `tsc --noEmit`
  de API y web limpios; `eslint` sobre los archivos tocados limpio. No se corrió E2E ni se
  levantaron servidores.

## Veredicto

No encontré P0 ni P1 en HEAD. El núcleo está bien: el orden de locks no abre deadlocks, el control
nuevo de `assertStillAvailable` no toca notas de crédito ni guías, y el cálculo de lo fabricado
usa la misma unidad en los dos lados. Quedan dos P2 (el motivo del menú deshabilitado no se ve, y
el criterio de NC por importe frente al neto por cantidad de D-346) y varios P3 de texto y de UX.

## Lo que se verificó y está bien

- **Llamadores de `cancel`**: solo `SalesController.cancelOrder` y `PosService.void`
  (`apps/api/src/pos/pos.service.ts:559`). El POS deshace antes el cobro, el comprobante (baja o
  NC total emitida en el acto) y el despacho, y corta antes de `cancel` si la baja queda en
  `VOID_PENDING`. Por eso `VOID_PENDING` (vivo en `LIVE_DOCUMENT_STATUSES`) no llega a bloquear
  ese camino. Una NC total suma sus líneas (D-169), igual que la boleta, así que
  `credited.lt(total)` da falso y no bloquea. Una venta de mostrador nunca tiene fabricado, así
  que la falta de `acknowledgeFabricated` no le pega.
- **`assertStillAvailable`** (`apps/api/src/invoicing/invoicing.service.ts:1911-1930`): la rama
  de `NOTA_CREDITO` y la de `GUIA_REMISION_REMITENTE` retornan antes. El control de pedido
  anulado solo alcanza a facturas y boletas con líneas de pedido. Si se corrige un rechazado de un
  pedido anulado (`correctInner` copia sin pasar por `resolveLines`), ahora se rechaza al emitir
  con «Descártalo», que es lo deseado.
- **Locks y carreras**: `cancel` toma pedido → reservas → borradores. `registerManual`, `send` y
  `assignInTx` bloquean solo su comprobante y no toman después el pedido, así que no hay ciclo.
  Los dos órdenes de la carrera terminan bien:
  - Si el registro commitea primero, el `FOR UPDATE` de `cancel` se reevalúa, salta la fila (ya
    no es `DRAFT`) y la consulta siguiente ve el comprobante vivo y bloquea.
  - Si `cancel` commitea primero, el registro ve `CANCELLED` y rechaza.

  Crear un borrador (`createInTx:496`), reactivar (`fiscal-import.service.ts:320/393`) y traer a
  otro pedido (`move-to-order.service.ts:381`) toman el pedido con `FOR UPDATE` y validan
  `CANCELLED`.

- **Unidades de lo fabricado**: el IN de producción entra en `MTR` si `sellsByLength(product)` y
  en `NIU` si no (`roofing-production.service.ts:1139-1141`), y en `NIU` en drywall
  (`production.service.ts:712`). `dispatch_items.reserve_qty` está en la unidad del ítem de
  kardex, que para `itemType = PRODUCT` es la del producto. Los dos lados coinciden. Los ajustes
  de costo del cierre usan `refId = orderId`, no el reporte, y el filtro por ids de reporte los
  deja fuera.
- **`salesOrderStatus` en `FiscalDocumentDto`**: es obligatorio en el schema, y `tsc` de API y
  web pasa, así que todo constructor tipado lo llena. `documentInclude` trae `status`.
- **E2E existentes**: las anulaciones directas (`fase5a`, `fase5a-bordes`, `fase7:530`,
  `fase7e:216/417`, `correcciones-03-listas-kardex:171`, `import-cotizaciones:378`) son de pedidos
  sin comprobante, sin despacho y sin fabricado. `traer-comprobante-d381` se reordenó bien:
  primero el comprobante y después el pedido. `huecos-cobertura-f8s3b:425` busca el diálogo por el
  nombre `Anular <código>`, que se conserva.
- **Selectores del E2E nuevo**: calzan con el DOM.
  - `getByLabel('Motivo')` → `htmlFor="cancel-order-reason"`.
  - La casilla es un `<button role=checkbox id=cancel-ack-fabricated>` con su `Label`; `.check()`
    funciona sobre `aria-checked`.
  - `24.6 MTR` sale de `toDecimal('24.600').toString()`.
  - `getByTestId('cancel-fabricated')` existe.
  - `headerAction(page, 'Anular pedido')` abre «Más acciones» y encuentra el `menuitem`.

## Hallazgos

### P2-1 — El motivo de «Traer comprobante anulado» deshabilitado no se ve

`apps/web/src/app/(app)/pedidos/[id]/pedido-detalle-view.tsx:455-458`

**Escenario:** pedido con una factura viva y el administrador abre «⋯». El ítem sale apagado y el
motivo va en `title`. Pero `DropdownMenuItem` lleva `data-disabled:pointer-events-none`
(`apps/web/src/components/ui/dropdown-menu.tsx:66`): el ítem deshabilitado no recibe hover y el
tooltip nativo nunca aparece.

El alcance (5) pide «deshabilitado **con motivo**»: hoy el motivo no es visible. Hay precedente del
mismo patrón (`comprobante-detalle-view.tsx:680`, `pseOffTitle`), así que probablemente es un
defecto de la plantilla y no solo de D-383. Conviene comprobarlo en el navegador y, si se
confirma, mostrar el motivo como texto (subtítulo del ítem o aviso en el detalle).

### P2-2 — El criterio de «comprobante acreditado por completo» es por importe, no el neto por cantidad de D-346

`apps/api/src/sales/order-cancel-checks.ts` (`commercialCancelBlocks`, `credited.lt(total)`)

El resto del sistema decide cuánto factura un comprobante con `invoicedByOrderItem`: neto por
línea y cantidad, la función de `orderProgress` y de `assertStillAvailable`. Acá se compara el
`totalPen` de la cabecera contra la suma de NC vivas. Los dos criterios divergen cuando la
cabecera no es exactamente Σ líneas o cuando la NC no es proporcional a cantidades.

**Escenario:** un manual o importado cuyo total del papel difiere en céntimos de la suma de sus
líneas (D-359, importes del papel), acreditado con una NC total. `createCreditNote` suma las
líneas restantes, así que la NC queda unos céntimos por debajo del total de la cabecera. El pedido
queda bloqueado para siempre: no se puede emitir otra NC («No queda nada por acreditar») y el
mensaje pide anular un comprobante que ya está deshecho.

El [WIP] redondea a 2 decimales, lo que cubre restos del cuarto decimal pero no una diferencia de
céntimos. Recomendación: usar el neto de `invoicedByOrderItem` sobre las líneas del pedido
(«¿alguna línea queda facturada > 0?») y nombrar los comprobantes que aportan ese neto. Así la
regla es la misma que la de facturar.

### P3-1 — El aviso del comprobante anulado recomienda «Traer» también para importados

`apps/web/src/app/(app)/comprobantes/[id]/comprobante-detalle-view.tsx:817-825`

La condición usa `canReactivate(d)`, que incluye `origin = IMPORTED`, pero `MoveToOrderService`
solo acepta `MANUAL` (`move-to-order.service.ts:343`). **Escenario:** un importado anulado de un
pedido anulado muestra «usa ⋯ → Traer comprobante anulado», y en el diálogo de traer no aparece
como candidato. Conviene condicionar el texto a `origin === 'MANUAL'`.

### P3-2 — Una sola casilla para todas las líneas

`apps/web/src/components/sales/cancel-order-dialog.tsx:139-151`

El alcance dice «aviso con casilla por línea (SKU, cantidad, OP)». La implementación lista por
línea y pone una única casilla global; el API recibe un único booleano. Si el dueño quiso una
casilla por línea, falta. Si quiso «el aviso por línea, con su casilla», está bien. Hay que
confirmarlo con él, no suponerlo.

### P3-3 — El diálogo no se refresca tras un rechazo

`apps/web/src/components/sales/cancel-order-dialog.tsx` y `pedido-detalle-view.tsx:127-136`

`onError` solo muestra el toast. **Escenario:** entre la vista previa y el click aparece un
bloqueo, por ejemplo otro usuario registra una factura. El 400 se muestra, pero el diálogo sigue
con la vista previa vieja y el botón activo: el usuario reintenta y obtiene lo mismo. Sugerencia:
`preview.refetch()` en el error de la mutación. El segundo modelo levantó lo mismo para el fallo
de la propia vista previa (su P3-5).

### P3-4 — El texto «nadie lo toma» no es cierto para todo lo fabricado

`order-cancel-checks.ts:173` (JSDoc), `:296` (mensaje), `cancel-order-dialog.tsx:135`

El argumento es que una línea a pedido reserva bobina, que el mostrador excluye coberturas y
metros, y que nadie toma ese stock. Vale para coberturas a medida en `MTR`, pero lo fabricado en
`NIU` puede quedar disponible para otros pedidos que reservan producto de stock:

- perfiles de drywall producidos contra pedido (`production.service.ts:712`);
- planchas de catálogo (`sellsByLength = false`).

Al liberar la reserva, ese stock queda libre y vendible. El mensaje promete algo que el sistema no
garantiza. Conviene decir «queda en inventario sin pedido» sin afirmar que nadie lo toma, o
verificarlo por tipo de producto.

### P3-5 — La indicación para un comprobante vivo no sirve para `SEND_ERROR`/`ISSUED`

`order-cancel-checks.ts:111`

Para un comprobante `ISSUED_HERE`, el mensaje dice «anúlalo (… con baja o nota de crédito)». Un
`SEND_ERROR` o un `ISSUED` no se da de baja: la baja exige aceptado, como ya anota
`purgeInvoicingTrail` en el paso 2. Lo que corresponde es reintentar el envío. Hoy
`PSE_ENABLED` está apagado en producción, así que el impacto es bajo.

### P3-6 — La unidad se muestra en código SUNAT

`cancel-order-dialog.tsx:129` y el mensaje del 409

Se ve «24.6 MTR» o «3 NIU». Si el web ya tiene una etiqueta de unidad (metros, piezas), conviene
usarla.

### P3-7 — La confirmación no se ata a lo que se vio

`sales-orders.service.ts:2288`

`acknowledgeFabricated: true` vale para cualquier fabricado que exista al anular, aunque la vista
previa mostrara otro. En la práctica casi no se alcanza: una OP que empieza a fabricar entre la
vista previa y el click pasa a `IN_PROGRESS` y bloquea por su cuenta. Se anota solo como riesgo:
la auditoría registra lo que había al anular, no lo que se vio.

### P3-8 — [WIP] Borradores que bloquean: purgas y POS

- **Purgas de E2E.** Con la decisión del dueño de que un borrador bloquea, solo
  `purgeInvoicingTrail` descarta borradores. `purgeSalesTrail` (`e2e/helpers/sales.ts:861`) y
  `purgeRoofingTrail` (`e2e/helpers/roofing.ts:720`) siguen tragándose el rechazo, igual que
  ante un comprobante vivo o un despacho (P2-1 del segundo modelo). Specs que crean despacho o
  comprobante y solo usan esas purgas, a revisar: `descripcion-linea-d283`, `fase7`, `fase7b`,
  `kardex-clickable-f8s5`. En cada caso, el pedido no anulado deja reservas para los casos
  siguientes.
- **POS.** Si `PosService.void` falla después de `createCreditNote` y antes de que `send` deje la
  NC emitida, queda una NC en borrador con el `salesOrderId` del pedido, que ahora entra en
  `candidates` como borrador y bloquea el `cancel` del reintento. Además el reintento recalcula el
  camino y crearía otra NC. El camino es raro, pero conviene que el reintento del POS descarte o
  reutilice su propio borrador de NC.
