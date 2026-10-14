# Ventana cc52 — correcciones 08 (NC con devolución, PEPS contra promedio, filtro de bobinas) y piso en el mostrador

2026-10-14, Lima. Dos cortes, cada uno con su PR y merge de a uno, más el cierre de docs. Decisiones D-642..D-648,
provisionales. **Una migración** (`20261014_sales_returns`, OK del dueño por nombre). Sin SQL contra producción.

## En producción

- **Corte A (PR #199, merge `5ae9617b`):** API `ayr-steel-erp-api-00124-pd2` (`git-sha=035f28f7`), desplegada antes
  del merge, y web de `5ae9617b`. `smoke:prod` en verde en los dos dominios (Vercel publicó en ~5 min).
- **Corte B (PR #200, merge `ed78afd6`):**
  - Respaldo Neon `respaldo-pre-cc52-20261014` (`br-shy-dew-ae5et5wc`, padre `production`); 9 ramas de 10.
  - Migración aplicada con `pnpm db:prod` (antes: pendiente solo la de cc52; después: «Database schema is up to
    date!»). SQL final mostrado al dueño antes de aplicarla; comprobada antes en una base nueva (el `ADD VALUE` no se
    usa en la misma transacción; `migrate diff` = `drift-esperado.sql`) y en la rama Neon `ci` (smoke de la CI).
  - API `ayr-steel-erp-api-00125-fcv` (`git-sha=dfae735d`), desplegada antes del merge; web de `ed78afd6`.
    `smoke:prod` en verde en los dos dominios. Lo posterior a `dfae735d` no toca runtime (`git diff --quiet` = 0).
- **Vuelta atrás:**
  - Corte B: `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00124-pd2=100` y
    revert del merge. Las tablas nuevas quedan (la API anterior no las lee); una NC de devolución registrada
    mientras tanto conserva su reingreso (se revierte anulándola con la API nueva).
  - Corte A: a `00123-crm` y revert del merge (smoke con `--expect-api-sha 99601795`).

## Paso 0 (detalle en `local-data/cc52/INFORME.md`)

- NC hoy: no movían el kardex; Ventas y margen no bajaba el costo y el pedido quedaba «no comparable» con la NC en
  otro mes; CxC es una foto al día.
- Kardex: las cantidades de Promedio y PEPS coinciden en todos los ítems (`pnpm inspect:cc52`, solo lectura); los
  valores difieren por salidas grabadas con fecha atrasada después de compras posteriores. Cifras reales solo en el
  informe al dueño. → D-648 y la pieza cc53.

## Qué entró

### Corte A

- **D-642:** `coilQuerySchema.receivedFrom/receivedTo` → `CoilsService.findAll` (y el PDF); `bobinas-view.tsx`.
- **D-643:** `createDirectInTx` aplica el piso también con `counterSale` y `allowAtCost`; `PosService.sell` llama a
  `assertAtCostRequest`; auditoría `pos.order.line-at-cost` (`atCostLineAuditEntries`). Web: `posFloorStatus` y
  `AtCostControl` en `pos-view.tsx`. El stock E2E del mostrador baja su costo por defecto a 5; el E2E que afirmaba
  «el mostrador no tiene piso» quedó invertido.
- **D-644:** AGENTS.md §3 regla 1 y las skills `ayr-cierre` y `ayr-ventana`.
- **D-648:** `InventoryService.assertBackdatedCost` (antes que D-124), `backdated-cost.ts`, `acceptBackdatedCost` en
  `backdatableFields` y en todos los caminos de salida con fecha; auditoría `inventory.backdated-cost-accepted`.
  Web: `useBackdateConfirm` / `BackdateConfirmDialog` con `costMismatch` (sin botón para otro rol);
  `dispatch-at-issue-date.tsx` y la corrección de fecha del comprobante.
- `auth.service.ts`: `DUMMY_PASSWORD_HASH` constante (causa de la intermitencia).
- `scripts/inspect-cc52.mjs` → `apps/api/prisma/inspect-cc52-cli.ts`.

### Corte B

- Migración `20261014_sales_returns`; `SalesReturnsService` (`sales-returns.service.ts`) y
  `sales-return-allocation.ts`; `invoicing.service.ts` (`createCreditNote`, `registerManual`, `assignInTx`,
  `updateManualIssueDateInTx`); `fiscal-import.service.ts` (`annulExternal` revierte la devolución);
  `dispatches.service.ts` (`reverseInTx` bloquea con devolución vigente); `invoicing-net.ts` (`withReturnedQty`);
  `sales-margin.service.ts` (filas `RETURN`); `kardex-peps.service.ts` (código 24); `audit-entity-refs.ts`
  (`sales_returns`, `inventory_movements`). `GET /invoicing/returns/:id` (costo solo ADMINISTRADOR).
- Web: diálogo de NC (tipo y fecha, `credit-note-form.ts`), `/devoluciones/[id]`, `sales-return-link.tsx`, etiquetas
  de auditoría, Comprobantes con `/devoluciones` en el menú.
- `seed:escenarios`: caso **NC** (bobina vendida y devuelta); la limpieza anula primero las NC.

## Verificación

- Lint, typecheck y Prettier en verde en los dos cortes. Unitarias de API: 3 402 (A) y 3 419 + las de cobertura (B).
  Web: 345.
- db-spec en base propia: `backdated-cost` 5/5, `pos-floor` 5/5, `sales-returns` 11/11.
- E2E en base propia: `mostrador-piso-cc52`, `nc-devolucion-cc52`, `precios-d161-d163`, `mostrador-precio-cc27`,
  `a-costo-cc51`, `fase7b`, `fase7b-bordes`, `importe-importado-d169`. CI completa en verde en los dos PR (también el
  smoke de Neon `ci` con la migración y `seed:escenarios`).
- Sonar: cobertura de código nuevo 80 %+ en los dos PR (con unitarias agregadas para eso).
- Capturas a 1366×768 en `local-data/cc52/capturas/`.

## Revisiones

- Corte A: sin P0. P1 corregido (la herramienta de D-285 sin la opción). P2 corregidos (redondeo, diálogo para quien
  no es administrador, rechazo del re-fechado, pruebas). P2 anotado: una salida a una fecha sin saldo no se compara.
- Corte B: P0 corregido (doble reingreso al revertir el despacho). P1 corregidos (refacturar lo devuelto; reparto por
  comprobante y fecha). P2 corregidos (fecha al registrar, NC sobre comprobante electrónico, despachos no
  bloqueados, re-fechado con devolución, margen con devolución vigente, alcance por vendedor).
- Informes en `docs/revision/cc52-{a,b}-*.md`.

## Pendiente / para la siguiente sesión

- **El dueño:** ratificar D-642..D-648; UAT en `docs/uat/cc52.md`.
- **cc53 · recosteo del promedio por fecha** (ver PROGRESO): al terminarla se quita D-648.
- Neon: 9 de 10. `respaldo-pre-cc08-20261001` y `respaldo-pre-cc41-20261010` proponibles para borrar (OK por nombre).
- P3 anotados: ver `local-data/cc52/INFORME.md` y las revisiones (redondeo de partes, par concurrente en
  `lock-order.db-spec.ts`, rentabilidad por comprobante sin el costo de la devolución, NC 03/13 como descuento).
- `ayr_local` quedó con el juego de `seed:escenarios` (incluido NC) y un producto, una compra y una caja abierta
  «DEMO · captura cc52» de las capturas.

## Commits

- Corte A (PR #199): `a72e2c90` D-642/D-643/hash/diagnóstico; `e0b482c0` D-648 y D-644; `079e905a`, `b6b05293`
  specs y lint; `df496f7f` revisiones; `02d631bb` E2E del piso; `035f28f7` cobertura.
- Corte B (PR #200): devolución, revisiones, seed, E2E y cobertura (13 commits, hasta `dfae735d`).
