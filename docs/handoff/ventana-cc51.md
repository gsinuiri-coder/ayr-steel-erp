# Ventana cc51 — anular la factura del corte, detalle en castellano y vender a costo

2026-10-13, Lima. Dos cortes, cada uno con su PR y merge de a uno, más el cierre de docs. Decisiones
D-639, D-640 y D-641, provisionales. **Una migración** (`20261013_sales_line_at_cost`, OK del dueño por
nombre). Sin SQL contra producción. El dueño ratificó D-638 y aprobó el UAT de cc50.

## En producción

- **Corte A (PR #196, merge `3954ce6d`):** API `ayr-steel-erp-api-00122-rft` (`git-sha=a22d09aa`),
  desplegada antes del merge, y web de `3954ce6d`. `smoke:prod` en verde en los dos dominios.
- **Corte B (PR #197, merge `fe275849`):**
  - Respaldo Neon `respaldo-pre-cc51-20261013` (`br-divine-thunder-aetc4rfe`, padre `production`).
  - Migración aplicada con `pnpm db:prod` (antes: pendiente solo la de cc51; después: al día).
  - API `ayr-steel-erp-api-00123-crm` (`git-sha=99601795`), desplegada antes del merge.
  - **Vercel no inició el despliegue de producción de `fe275849`**: GitHub no tiene estado de Vercel
    ni despliegue para ese commit (el merge anterior sí). El smoke falló solo en «web publicada» tras
    10 minutos; health en `99601795` y todas las lecturas en verde. No se hizo vuelta atrás: la web
    anterior (`3954ce6d`) no manda ni lee los campos nuevos, así que web vieja con API y base nuevas es
    coherente, y revertir dependía del mismo disparo de Vercel. Se avisó al dueño. La web del corte B
    se publica con el merge del cierre de docs (que la incluye), verificado con el smoke.
- **Vuelta atrás:**
  - Corte B: `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00122-rft=100`
    y revert del merge; las dos columnas quedan (son opcionales y la API anterior no las lee).
  - Corte A: a `00121-jql` y revert del merge (smoke con `--expect-api-sha 700092ba`).

## Qué entró

### Corte A

- **D-639:** `purchases.service.ts` `cancel` → `cutting.invoice-cancelled` en la orden de corte
  (`cuttingInvoiceCancelledAuditEntry`), misma transacción.
- **D-640:** `packages/shared/src/audit-values.ts` (por clave y por prefijo de acción, también
  anidados y Sí/No), usado por `auditValueText`; la pantalla de Auditoría delega en él. Rótulos de las
  claves en `audit-labels.ts`. Tabla completa de traducciones en `local-data/cc51/INFORME.md`.
- `seed:escenarios`: H1 suma una factura del corte duplicada, recibida y anulada.

### Corte B — D-641

- Migración `20261013_sales_line_at_cost`: `at_cost_reason`, `at_cost_note` en `quotation_items` y
  `sales_order_items`.
- `price-floor.ts`: candidato `atCost` (margen 0; sin costo, 400; mensaje opaco con `opaqueAtCost`).
- `sales-lines.ts`: `allowAtCost` (solo cotización), `assertAtCostAllowed`, `markAtCostCandidates`,
  `attachAtCost`.
- `at-cost.ts`: `assertAtCostRequest` (403 antes del piso), `assertAtCostActor`, auditorías
  `sales.quotation.line-at-cost` y `…-removed`.
- `quotations.service.ts`: alta, edición (cliente bloqueado para otro rol con líneas a costo),
  duplicado (marca solo para ADMINISTRADOR). `sales-orders.service.ts`: confirmar copia la marca;
  panel de stock y bobinas vendibles con `atCostPricePen` solo para ADMINISTRADOR.
  `sales-order-edits.service.ts`: cambiar el precio quita la marca; cantidad (otro rol) y bobina,
  bloqueadas en una línea a costo.
- `invoicing.service.ts`: `withAtCostMarks`/`applyAtCostMarks` en el detalle del comprobante.
  `sales-margin.service.ts`: `atCost` por pedido y filtro.
- Web: `at-cost-control.tsx` («Vender a costo», etiqueta), `sales-document-form.tsx`, detalles de
  cotización, pedido y comprobante, Ventas y margen (modal con periodo y «A costo» en un `replace`).
- `seed:escenarios`: caso **AC** (bobina entera a costo, boleta y despacho); `seed:escenarios:test`
  cuenta 16 compras y 10 pedidos vivos.

## Verificación

- Lint (todo el repo, sin caché, también `e2e`), typecheck, Prettier; unitarias API 3 387 (2
  omitidas) y web 50 archivos. `auth.service.spec.ts` falló dos veces solo bajo carga y pasa sola:
  infraestructura.
- db-spec en base propia: `purchase-audit` 18/18, `at-cost` 13/13, `order-qty-change` en verde.
- E2E en base propia: `a-costo-cc51`, `precios-d161-d163`, `piso-importado-por-rol-d256`,
  `auditoria-d218`, `estandar-tablas-cc47`. CI completa en verde en los dos PR.
- `check:drift` en verde con la migración. Recorrido en `ayr_local` con capturas en
  `local-data/cc51/capturas/`.

## Revisiones

- Corte A: sin P0/P1/P2; P3 corregidos (búsqueda por propiedad propia, prueba negativa real).
- Corte B: sin P0. P1 corregidos (el costo se filtraba por el 400 a un vendedor; cambiar la bobina de
  una línea a costo). P2 corregidos (cantidad y cliente por otro rol, duplicado de bobina entera,
  auditoría de la marca quitada, prueba del filtro, cobertura). P2 anotado: confirmar no vuelve a
  comprobar el costo.
- Informes en `docs/revision/cc51-{a,b}-*.md`.

## Pendiente / para la siguiente sesión

- **El dueño:** ratificar D-639, D-640 y D-641; UAT en `docs/uat/cc51.md`.
- **Decisiones del dueño:** el mostrador (cualquier rol vende bajo costo, antes de habilitar las
  cuentas de vendedores) y si confirmar debe volver a comprobar el costo de una línea a costo.
- Neon: 8 de 10. `respaldo-pre-cc08-20261001` queda proponible para borrar (OK por nombre).
- P3 anotados en el informe y en las revisiones.
- `ayr_local` quedó con el juego de la última corrida de `seed:escenarios` (incluido AC) y dos
  cotizaciones DEMO de depuración (COT-000088, COT-000089) que anula la próxima corrida.

## Commits

- Corte A (PR #196): `60eecf75` auditoría y traducciones; `a22d09aa` revisión.
- Corte B (PR #197): `dc11313a` vender a costo; `71e245ea` revisiones; `c0b09ac1`, `fcad33e2`,
  `99601795` formato y lint.
