# Handoff — F8-S3c: planta directa, ML visibles, selector de cliente — 2026-09-13

## 1. Resumen

Sesión F8-S3c (Fase 8): tercera iteración sobre el feedback del dueño probando `dev:preview`. Solo UI/presentación (cero schema, lógica de dominio o endpoints nuevos). **M1–M4 entregados, nada sacrificado.**
Entorno **LOCAL**: 9 commits en `main` (`28ffc88..ce4bb01`) más este handoff, **sin push** por regla de la sesión. CI no corrió y no se desplegó nada.
Lint, typecheck y format en verde; **414/414 unitarios**. E2E completa (dos corridas limpias): **306 verdes, 2 saltados (cupo PSE), 0 caídos**.

## 2. Hecho

### M1 — `/planta` entra directo, sin card de cola separado (D-197)

- [planta-view.tsx](<../../apps/web/src/app/(app)/planta/planta-view.tsx>): el card «Cola de producción» de `PedidoWorkspace` se eliminó. La franja de chips (`aria-label="Órdenes del pedido"`) trae de una vez **todas** las órdenes del pedido, iniciadas o no, en el orden de `compareQueueRank` (D-189) — antes había que abrirlas primero desde la cola.
- El chip de una orden no iniciada absorbe lo que el card aportaba: `queueNote` («en cola desde X · Y kg teóricos»), cruzando el batch con `GET /production/roofing/queue` por `orderId`. Una orden ya iniciada no lo muestra.
- Se sacó el estado `pinned`/`openOrder`, que ya no hacía falta con todas las órdenes siempre visibles.
- [pedido-groups.ts](<../../apps/web/src/app/(app)/planta/pedido-groups.ts>): `seqOf` pasa a exportado, reusado para el ranking de perfiles en `planta-view.tsx`.
- [production-queue.tsx](../../apps/web/src/components/production-queue.tsx): `QueueEntryLink` (el botón clickable de la cola) se borró — quedó sin ningún uso. `QueueEntrySummary` sigue viva en la cola de cada pedido dentro de la lista general.

### M2 — La tarjeta del pedido enlaza su cotización de origen (D-198)

- [pedido-list.tsx](<../../apps/web/src/app/(app)/planta/pedido-list.tsx>): cada tarjeta de `/planta` (sin pedido) muestra, junto al título, un link al código de la cotización de origen (`/cotizaciones/:id`), estilo S9.
- [planta-view.tsx](<../../apps/web/src/app/(app)/planta/planta-view.tsx>): la cotización se resuelve leyendo `/sales/orders` completo (`fetchAllForPicker`, ya existente) y cruzando por `salesOrderId` — sin endpoint nuevo. Mismo tope de 200 que otros pickers.

### M3 — Padding de drawers y ML junto al kg (D-199)

- [planta-view.tsx](<../../apps/web/src/app/(app)/planta/planta-view.tsx>) y [compra-detalle-view.tsx](<../../apps/web/src/app/(app)/compras/[id]/compra-detalle-view.tsx>): los drawers «Abrir una orden nueva» y «Registrar pago» tenían el título pegado al borde (`SheetHeader className="px-0 pt-0"` sin padding en el contenedor). Se normalizaron al mismo patrón que ya usaba el drawer de stock (`sales-document-form.tsx`): padding en `SheetContent`, header en `p-0`.
- [product-stock-picker.tsx](../../apps/web/src/components/sales/product-stock-picker.tsx): el modal de elegir producto muestra el disponible de materia prima en ML con el kg entre paréntesis (`X.XXX m (Y kg)`), vía `kgPerMeter` del stock.
- [roofing-order-panel.tsx](<../../apps/web/src/app/(app)/planta/roofing-order-panel.tsx>): el «pendiente» de cada bobina montada en el workspace agrega su equivalente en ML, con `equivalentMeters` de `@ayr/shared` (misma cuenta de D-116, reusada y no reescrita tras el hallazgo del revisor).
- [bobina-detalle-view.tsx](<../../apps/web/src/app/(app)/bobinas/[id]/bobina-detalle-view.tsx>): el «Disponible» del detalle de bobina agrega su ML, usando `CoilDto.equivalentMeters` que ya traía el DTO sin usar en pantalla.
- Presentación pura: kardex y pool de materia prima siguen en kg.

### M4 — El selector de cliente siempre abre el buscador (D-200)

- [search-select-modal.tsx](../../apps/web/src/components/search-select-modal.tsx): `SearchSelectField` gana `forceModal` (nunca cae al `<select>` corto, ni con el maestro vacío), `actionLabel`, `extraAction` (render prop con `{close}`) y `emptyMessage`.
- [sales-document-form.tsx](../../apps/web/src/components/sales/sales-document-form.tsx): el campo «Cliente» de la cotización pasa a `forceModal`, con `actionLabel="Elegir"` y un `emptyMessage` propio. «+ Crear cliente» —antes al lado del campo— pasa a vivir **dentro** del modal (`extraAction`); crear uno cierra el modal y lo deja elegido.

### Revisión y QA

- **revisor**: sin bloqueantes ni altos.
  - Medio: `pedidoQueue` sin memorizar recomputaba `queueByOrder`/`rows` en cada render y disparaba de nuevo sus efectos — mismo patrón que `usePlantaOrders` ya había corregido para drywall. Corregido con `useMemo`.
  - Bajo: `equivalentMetersOf` de `roofing-order-panel.tsx` reescribía a mano la cuenta de `equivalentMeters()` de `@ayr/shared` en vez de llamarla. Corregido.
- **qa**: adaptó 6 specs a la vista directa (`openQueuedOrder` y los tests que dependían del card de cola) y sumó 2 specs nuevos:
  - [planta-chips-f8s3c.spec.ts](../../e2e/tests/planta-chips-f8s3c.spec.ts): chips con `queueNote` sin bobina y sin ella con bobina montada, orden por prioridad (M1); link a la cotización que navega a `/cotizaciones/:id` y no al pedido (M2).
  - [selector-cliente-f8s3c.spec.ts](../../e2e/tests/selector-cliente-f8s3c.spec.ts): con el maestro sin clientes propios (el único «vacío» alcanzable — `PÚBLICO EN GENERAL` es `isSystem` y no se puede desactivar) el modal se abre igual y ofrece el alta; con pocos clientes, «Elegir» está en cada fila sin buscar nada.
  - Encontró una **regresión real** de M4 en el helper compartido `e2e/helpers/ui.ts#chooseOption`: buscaba el botón de la fila por el nombre accesible exacto `Seleccionar {label}`; con el cliente en `actionLabel="Elegir"` dejó de encontrarlo y rompía 4 specs preexistentes que no tocan `/planta`. Corregido generalizando el helper a buscar el botón dentro de la fila, no por su nombre completo.

## 3. Decisiones tomadas

- **D-197**: `/planta` entra directo, sin card de cola separado; la franja de chips trae todas las órdenes del pedido de una vez, y el chip de la no iniciada absorbe la nota de cola.
- **D-198**: la tarjeta del pedido en `/planta` enlaza su cotización de origen, leyendo `/sales/orders` existente.
- **D-199**: el disponible de materia prima en coberturas se muestra en ML con el kg entre paréntesis (modal de producto, pendiente de bobina montada, detalle de bobina).
- **D-200**: el selector de cliente de la cotización siempre abre el buscador (`forceModal`), con el alta express dentro del modal.

## 4. Bloqueos / pendientes

- **Para el dueño:** mirar en `dev:preview` los cuatro puntos antes del deploy — la franja de chips sin cola separada, el link a la cotización, el ML junto al kg, y el selector de cliente con el alta adentro.
- **Menores, sin cerrar:**
  - El tope de 200 de `fetchAllForPicker` alcanza ahora también al link de cotización de M2 (además del selector de cliente, ya documentado): con más de 200 pedidos con producción pendiente, los más nuevos se quedan sin el link.
  - Un `m2-reversa-pago.spec.ts` (sesión M-2, no de esta) salió transitoriamente rojo en la primera corrida completa de la suite: `getByText('S/ 6,800.00')` resolvió a dos elementos porque el `SheetDescription` del drawer de pago (M3 de esta sesión tocó su padding, no su contenido) seguía en el DOM durante su animación de cierre. Aislado pasó 8/8 y la segunda corrida completa salió limpia — no se investigó más ni se tocó ese spec, es fuera de alcance.
- Nada desplegado. Esta sesión no agrega migraciones; la ventana V-3 sigue siendo F8-S1..S3c.

## 5. Cómo verificar

```
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check   # 414/414 unitarios
pnpm e2e                                                         # suite completa local (recrear ayr_local_e2e antes)
pnpm exec playwright test e2e/tests/planta-chips-f8s3c.spec.ts e2e/tests/selector-cliente-f8s3c.spec.ts e2e/tests/product-stock-picker-f8s2b.spec.ts
git log --oneline cfa7f6f..HEAD                                  # commits de la sesión
```

E2E suite completa, dos corridas con la base recreada antes de cada una: 305 verdes + 1 caída transitoria (§4) la primera; **306 verdes, 2 saltados (cupo PSE demo), 0 caídos** la segunda.

Nada que verificar contra producción ni demo: sesión local, sin deploy.

## 6. Siguiente sesión

1. Ventana de deploy V-3 con F8-S1..S3c. Migraciones D-182, D-184, D-185, D-187, D-189 y D-191; F8-S3b y F8-S3c no agregan. Verificar el backfill de prioridad en `demo` antes que en `production` y correr `pnpm smoke:prod` después.
2. Resto de la Fase 8 según §3.7: auditoría, reportes, UAT.
