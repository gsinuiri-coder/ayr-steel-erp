# Handoff — F8-S2: flujo comercial nuevo (emitir directo, reserva temporal, confirmar en un paso) — 2026-09-12

## 1. Resumen

Sesión F8-S2 (Fase 8). Se entregaron **M0–M4** del brief; **M5 (modal de productos con stock y
aviso «sin stock disponible») se sacrificó**, primero en el orden de sacrificio del brief.
Entorno **LOCAL**: commits en `main`, **sin push** (regla de la sesión); CI no corrió. En local:
lint/typecheck/format en verde, **403/403 unitarios**, suite E2E completa: 265 verdes, 2 saltados (cupo PSE demo) y 1 caída transitoria (`ECONNRESET` a los 17 ms en `bobina-consumos-pdf-d172.spec.ts`, spec que la sesión no tocó; aislado pasó 3/3).
Nada desplegado.

## 2. Hecho

### M0 — idempotencia cableada en los formularios

- `apps/web/src/lib/use-idempotency-key.ts`: una clave por intento de submit; se conserva solo
  si el resultado es incierto (red o 5xx) y se renueva con éxito o 4xx. Sin
  `crypto.randomUUID` (contexto no seguro) cae a un respaldo.
- Cableado en reporte de producción (`planta/roofing-order-panel.tsx`,
  `planta/drywall-order-panel.tsx`), cobro (`comprobantes/[id]/comprobante-detalle-view.tsx`)
  y pago a proveedor (`compras/[id]/compra-detalle-view.tsx`), y en «Agregar ítems» (M4).

### M1 — la cotización nace emitida y se edita hasta confirmarla (D-184)

- `quotations.service.ts`: alta y duplicado → `EMITTED` con PDF; `POST /emit` eliminado; `PUT`
  acepta emitida o vencida (editar renueva), rechaza confirmada/anulada; PDF regenerado en cada
  edición sobre la misma key; piso de precio en cada edición.
- Migración `20260912140000_d184_cotizacion_nace_emitida` (DRAFT → EMITTED; el valor del enum
  se conserva).
- Web: `/cotizaciones/[id]/editar` (mismo `SalesDocumentForm`), sin Emitir ni «Reservará».
  Editar una vencida siembra la fecha de emisión en hoy.

### M2 — reserva temporal (D-185)

- Tabla `quotation_reservations` + `sales_settings` (migración
  `20260912150000_d185_reserva_temporal`). Vence al final del N-ésimo día hábil en Lima (3 por
  defecto, `/configuracion/reservas`) y **nunca después de la vigencia de la cotización**.
- **Sin jobs**: `liveTemporaryWhere` y `sweepExpiredTemporaryReservations`
  (`apps/api/src/sales/reserved-ledger.ts`). `reservedByItem` es la única suma de reservado del
  API (firme + temporal vigente): pool D-154, panel de stock, mostrador, inventario, venta de
  bobina, selector de bobinas de planta.
- Editar con reserva recalcula en la misma transacción (mismo vencimiento; si no alcanza, la
  edición entera se deshace); anular la cotización la libera.
- Web: botón Reservar y tarjeta en el detalle, `/reservas-temporales` (tiempo restante,
  liberar con motivo), pestaña en Administración.

### M3 — confirmar en un paso (D-186)

- `confirm()`: convierte la temporal, reserva en firme y crea la OP de cada línea de materia
  prima (`createFromReservationInTx`, plan por defecto), todo en una transacción. Reventa y
  servicios no generan OP. **Bloquea si falta MP** (decisión del dueño en la sesión).
- `GET /quotations/:id/confirm-preview` (solo lectura) + `confirm-quotation-dialog.tsx`: qué
  reserva cada línea, qué OP y con qué plan, faltante y bloqueos; confirma con un clic.
- **Anular el pedido anula sus OP en borrador sin reportes**; si una empieza a fabricarse en
  el medio, la anulación se deshace.

### M4 — edición del pedido confirmado hasta comprobante (D-187)

- `apps/api/src/sales/sales-order-edits.service.ts`, bajo el lock del pedido; corte = factura
  o boleta en borrador o viva (crear el comprobante toma el mismo lock):
  - precio de línea (ADMINISTRADOR, piso D-163);
  - cliente (ADMINISTRADOR, con motivo);
  - agregar ítems (dueño o ADMIN, aun con despacho parcial; reserva + OP; idempotente);
  - cantidad (dueño o ADMIN) solo sin reportes, OP cerrada, producto fabricado ni despachos;
    si no, 400 que manda a agregar un ítem. Ajusta reserva y plan de la OP.
- Registro `sales_price_changes` (migración `20260912160000_d187_registro_cambios_precio`,
  aditiva); también lo escribe la edición de la cotización. Visible en «Cambios de precio» del
  detalle de cotización y de pedido.
- Web: `/pedidos/[id]/agregar`, `order-edit-dialogs.tsx`, `price-changes-card.tsx`.

### E2E

- Specs del flujo viejo **adaptados, no borrados** (`/emit` fuera, helpers que devuelven la OP
  existente, `returnToProductionQueue` para los specs de cola).
- Nuevos: `flujo-comercial-f8s2.spec.ts` (reserva temporal: crear, vencer lazy con
  `helpers/db.ts`, liberar, convertir; vista previa y confirmar), `pedido-edicion-f8s2.spec.ts`
  (registro de precios, permisos, agregar ítem, cantidad, comprobante corta, UI),
  `flujo-comercial-f8s2-ui.spec.ts` (de `qa`: edición con registro, vendedor, faltante en el
  diálogo, reservas temporales, largos desde el diálogo, carrera del catálogo).

## 3. Decisiones tomadas

- **D-184** — La cotización nace emitida y se edita hasta confirmarla; PDF de versión única.
- **D-185** — Reserva temporal en tabla aparte, expiración perezosa, suma de reservado
  centralizada.
- **D-186** — Confirmar = pedido + reserva firme + OPs en una transacción, con vista previa;
  bloquea por faltante; anular arrastra las OP en borrador; la cola deja de recibir pedidos
  recién confirmados.
- **D-187** — Edición del pedido confirmado hasta comprobante con registro de cambios de precio.

## 4. Bloqueos / pendientes

- **M5 sacrificado**: modal de selección de productos con stock, aviso y marca «sin stock
  disponible», tarjeta del Panel «Cotizaciones sin stock disponible». Sin empezar.
- **Cola de producción (D-093/D-094/D-096)**: un pedido recién confirmado ya no aparece en la
  cola (su OP en borrador **es** la línea en cola). La prioridad manual y el semáforo de fecha
  prometida siguen existiendo en el pedido y en la cola, pero **no se verificó si `/produccion`
  y `/planta` ordenan las OP en borrador por esos criterios**. Si no, esa priorización se perdió
  para pedidos nuevos: revisar con el dueño.
- **Hallazgos menores del revisor sin cerrar**:
  - editar una cotización con reserva temporal sobre una **bobina entera**: esa bobina
    probablemente no aparece en `/sales/sellable-coils` (su disponible ya lo descontó la propia
    reserva) — deducido del código, no probado;
  - «Agregar ítems»: si el envío falla por red y el vendedor cambia las líneas antes de
    reintentar, la clave de idempotencia se conserva y el API puede devolver el primer envío;
  - editar una cotización sin vencimiento (D-157) muestra un campo de vigencia que el API ignora;
  - el título de los diálogos de precio/cantidad parpadea al cerrar.
- El recálculo de la reserva temporal al editar conserva el vencimiento original aunque la
  edición acorte la vigencia de la cotización.
- `idempotency_keys` sigue sin limpieza (heredado de F8-S1).
- Nada desplegado: todo queda para la próxima ventana de deploy, que debe aplicar las tres
  migraciones de la sesión (todas aditivas; la de D-184 convierte `DRAFT` → `EMITTED`).

## 5. Cómo verificar

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check   # 403/403 unitarios
pnpm e2e                                                         # suite completa local
pnpm exec playwright test e2e/tests/flujo-comercial-f8s2.spec.ts e2e/tests/pedido-edicion-f8s2.spec.ts e2e/tests/flujo-comercial-f8s2-ui.spec.ts
git log --oneline c1b4153..HEAD                                  # commits de la sesión
```

Nada que verificar contra producción ni demo: sesión local, sin deploy.

## 6. Siguiente sesión

1. Revisar con el dueño la priorización de OP en borrador (§4, cola de producción) antes del
   deploy: es la única consecuencia de D-186 que cambia cómo trabaja planta.
2. M5 (modal con stock y «Cotizaciones sin stock disponible»), si sigue siendo prioridad.
3. Ventana de deploy V-3 con F8-S1 + F8-S2 (migraciones D-182, D-184, D-185, D-187).
4. Resto de la Fase 8: auditoría, reportes, UAT.
