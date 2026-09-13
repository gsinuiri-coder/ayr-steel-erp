# Handoff — F8-S3: cola de OPs, órdenes dentro del pedido, borrador de reportes por OP — 2026-09-13

## 1. Resumen

Sesión F8-S3 (Fase 8), a partir del feedback del cliente sobre la confusión entre la página de producción y la de órdenes. Se entregaron **M1–M5 completos**; no se sacrificó nada.
Entorno **LOCAL**: 11 commits de código y tests en `main` (`51699ab..d85acd4`) más el de docs, **sin push** por regla de la sesión; CI no corrió.
Lint, typecheck y format en verde; **414/414 unitarios**. E2E completa: 294 verdes, 2 saltados (cupo PSE), 0 caídos (§5). Nada desplegado.

## 2. Hecho

### M1 — la cola son las OPs no iniciadas (D-189)

- `RoofingProductionService.queue` → `GET /production/roofing/queue`: OPs de coberturas en borrador, sin bobina montada y sin reportes ([roofing-production.service.ts](../../apps/api/src/production/roofing-production.service.ts)).
- Prioridad manual migra de `sales_orders` a `production_orders`. La migración `20260913100000_d189_prioridad_en_la_op` es aditiva y copia la prioridad a las OP vivas. Se agrega `PATCH /production/roofing/:id/priority` y se retira `PATCH /sales/orders/:id/priority`.
- Un solo ranking, `compareQueueRank` ([sales.ts](../../packages/shared/src/schemas/sales.ts)), para la cola y para `batchOrders` (`/planta`). Orden: prioridad manual; dentro de cada grupo, vencidas arriba; después fecha compromiso; desempate por correlativo. Lo cubre [queue-rank.spec.ts](../../apps/api/src/production/queue-rank.spec.ts).
- La cola vieja pasa a `GET /sales/orders/lines-without-order`, que en «Abrir una orden nueva» se muestra como «Líneas de pedido sin orden».
- `/planta` tiene la tarjeta «Cola de producción» siempre visible; un clic abre esa OP en el workspace ([production-queue.tsx](../../apps/web/src/components/production-queue.tsx), [planta-view.tsx](<../../apps/web/src/app/(app)/planta/planta-view.tsx>)).
- E2E: `returnToProductionQueue` eliminado. `fase7`, `fase7-bordes`, `fase7-consolidada-subtipo` y `plancha-contra-pedido-d171` se reescribieron contra las OP. Los casos que solo necesitaban la reserva sin orden usan `cancelAutoCreatedOrders`.

### M2 — las OPs viven en el pedido (D-190)

- [production-orders-card.tsx](<../../apps/web/src/app/(app)/pedidos/[id]/production-orders-card.tsx>) en el detalle del pedido. Muestra estado, prioridad (con botón para priorizar), bobina montada, avance en ML, link al detalle y «Producir».
- `GET /production?salesOrderId=`.
- `/produccion` sale del menú y redirige a `/planta?historial=1`. El listado viejo pasa a [order-history.tsx](../../apps/web/src/components/production/order-history.tsx). Se conserva `/produccion/:id`.

### M3 — borrador de reportes por OP (D-191)

- Tablas `production_report_drafts` y `production_report_draft_pieces` (migración `20260913110000_d191_borrador_de_reportes`).
- Validación pura en [roofing-drafts.ts](../../apps/api/src/production/roofing-drafts.ts); servicio y commit en [roofing-drafts.service.ts](../../apps/api/src/production/roofing-drafts.service.ts). Se agregan unitarios.
- Validación inmediata al ingresar y revalidación dentro de la transacción del commit, que es todo o nada. Si falla, el mensaje dice «Fila N:».
- Idempotencia con alcance por orden; tope de 50 filas.
- Guardas en `closeInTx`, `releaseCoil` y `updatePlan`; `cancel` descarta el borrador.
- Pantalla: [roofing-order-panel.tsx](<../../apps/web/src/app/(app)/planta/roofing-order-panel.tsx>) reescrito con agregar, corregir, quitar, ejecutar y ejecutar y cerrar.

### M4 — multi-montar con peso inicial (D-192)

- `coilIds` en `POST /production/roofing/:id/coils`: todo o nada; la comprobación del agregado corre una vez por montaje.
- `weightKg` en las opciones.
- Modal con casillas y peso inicial: [coil-picker.tsx](<../../apps/web/src/app/(app)/planta/coil-picker.tsx>).

### M5 — reapertura visible de bobinas cerradas (D-193)

- `?includeClosed=true`: consulta aparte de cerradas con saldo o ajuste vivo, con `closeAdjustment`.
- `CoilOperationsService.reopenInTx` ([coil-operations.service.ts](../../apps/api/src/coils/coil-operations.service.ts)) dentro del montaje. Hace un asiento compensatorio del `CLOSE_ADJUSTMENT` y nunca edita el original.
- Sin `reopenCoilIds` la bobina cerrada se rechaza.
- Paso explícito en el modal: «cerrada con ajuste de X kg — reabrirla revierte el ajuste», con motivo obligatorio.

### Revisión y QA

- **Revisor API** (sin bloqueantes). Se corrigieron 2 ALTO:
  - montar N bobinas recorría el agregado N veces y podía llegar a P2028;
  - las cerradas desplazaban a las bobinas nuevas del tope de 500.

  También se corrigieron:
  - medios: tope de filas del borrador y guarda en `updatePlan`; el cruce de locks al montar solo se documentó (ver §4);
  - bajos: clave de idempotencia por orden, cola sin tope y lectura muerta de `priority_reason`.

- **Revisor web** (sin bloqueantes). Se corrigió el ALTO: «Ejecutar y cerrar» estaba habilitado con una fila escrita y sin agregar, y cerraba la orden sin ella. También los 4 medios:
  - OPs fijadas en `/planta`;
  - corrección descartada al montar o guardar el plan;
  - fila corregida que desaparece;
  - texto del cierre alineado con el API.

  Y varios bajos: la entrada de la cola tiene nombre accesible y ya no hay bloques dentro de `<button>`.

- **qa**: [huecos-cobertura-f8s3.spec.ts](../../e2e/tests/huecos-cobertura-f8s3.spec.ts), 6 casos: borrador en pantalla, fallo «Fila 2», roles, qué entra en la cola, hoja de planta con prioridad y montajes inválidos. No encontró defectos de la app.
- E2E nuevos de la sesión: [planta-cola-f8s3-ui](../../e2e/tests/planta-cola-f8s3-ui.spec.ts), [borrador-reportes-f8s3](../../e2e/tests/borrador-reportes-f8s3.spec.ts), [multi-montar-f8s3](../../e2e/tests/multi-montar-f8s3.spec.ts), [reabrir-bobina-montar-f8s3](../../e2e/tests/reabrir-bobina-montar-f8s3.spec.ts).

## 3. Decisiones tomadas

- **D-189**: la cola son las OPs no iniciadas. La prioridad pasa a la OP y la fecha prometida se hereda del pedido. Un solo ranking compartido.
- **D-190**: las OPs viven en el detalle del pedido. `/produccion` redirige al historial en `/planta`.
- **D-191**: borrador server-side de reportes por OP, con validación doble y commit todo o nada.
- **D-192**: montar varias bobinas en una transacción, con el peso inicial visible.
- **D-193**: reabrir una cerrada desde el modal de montar, con confirmación y asiento compensatorio en la misma transacción.

## 4. Bloqueos / pendientes

- **Menores, sin cerrar:**
  - «Agregar al borrador» no tiene idempotencia: un doble clic duplica la fila. No mueve kardex y se quita a mano.
  - El cambio de cantidad del pedido (D-187) reescribe el plan de la OP sin mirar el borrador; el commit lo detecta y nombra la fila.
  - Montar puede cruzar locks con otro montaje concurrente de la misma spec. Ya pasaba con una sola bobina; queda documentado en el código.
  - El modal cierra antes de que responda la reapertura, así que si falla se pierde el motivo escrito.
  - El historial ordena por `createdAt` y no por `operationDate` (heredado de `/produccion`).
- **Cambio de contrato para la ventana de deploy:**
  - se retiran `PATCH /sales/orders/:id/priority` y `GET /sales/orders/queue`;
  - `SalesOrderDto` pierde `priority*`;
  - las columnas `sales_orders.priority_*` quedan sin escritor (additive-first; su borrado es una limpieza futura).
- `idempotency_keys` sigue sin limpieza (heredado de F8-S1).
- Nada desplegado. La próxima ventana (V-3) tiene que aplicar **las migraciones de F8-S1/S2 más las dos de esta sesión** (D-189 con backfill, D-191).

## 5. Cómo verificar

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check   # 414/414 unitarios
pnpm e2e                                                         # suite completa local
pnpm exec playwright test e2e/tests/planta-cola-f8s3-ui.spec.ts e2e/tests/borrador-reportes-f8s3.spec.ts e2e/tests/multi-montar-f8s3.spec.ts e2e/tests/reabrir-bobina-montar-f8s3.spec.ts e2e/tests/huecos-cobertura-f8s3.spec.ts
git log --oneline b8aa038..HEAD                                  # commits de la sesión
```

E2E suite completa:

- **Primera corrida**: 291 verdes, 2 saltados (cupo PSE), 3 caídos.
  - Un test propio con pasos en mal orden.
  - `huecos-cobertura-f8s2b` (tarjeta vacía) roto por cotizaciones que los specs de cola no purgaban.
  - Un `ECONNRESET` transitorio.
- Los tres se corrigieron o reverificaron: 19/19 en aislado.
- **Segunda corrida**: 293 verdes, 2 saltados, 1 caído: el mismo caso de F8-S2b con **otra** cotización sobrante (una venta de bobina entera de 500 kg). El test asumía base recién reseteada, pero el reset es uno por corrida. Se volvió determinista con `page.route` (`d85acd4`). No se rastreó qué spec deja esa cotización sin purgar.
- **Tercera corrida**: **294 verdes, 2 saltados (cupo PSE demo), 0 caídos**.

Nada que verificar contra producción ni demo: sesión local, sin deploy.

## 6. Siguiente sesión

1. Ventana de deploy V-3 con F8-S1 + F8-S2 + F8-S2b + F8-S3. Migraciones: D-182, D-184, D-185, D-187, D-189 y D-191. Verificar el backfill de prioridad en `demo` antes que en `production`.
2. Mostrarle al dueño en `dev:preview` la cola, el borrador y la reapertura antes del deploy: cambian cómo trabaja planta.
3. Pendientes menores de §4 (idempotencia de «Agregar al borrador», historial por `operationDate`).
4. Resto de la Fase 8: auditoría, reportes, UAT.
