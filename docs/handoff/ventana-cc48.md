# Ventana cc48 — Cierre de cc47 y auditoría legible

2026-10-12, Lima (mañana y tarde). Sesión continua, con la ventana suspendida (D-533). Dos cortes, cada uno
con su PR y merge de a uno. Sin migraciones ni SQL contra producción. Decisiones D-627 a D-635: D-633
aprobada por el dueño; las demás, provisionales. El dueño ratificó D-606 a D-626.

## En producción

- **Corte A (PR #187, merge `cebdb94f`):** API `ayr-steel-erp-api-00118-x92` (`git-sha=85703550`) y
  web. `smoke:prod` verde en los dos dominios.
- **Corte B (PR #188, merge `31adda6f`):** API `00119-dkj` (`git-sha=e28853a5`) y web. `smoke:prod`
  verde en los dos dominios.
- Vuelta atrás: `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=<anterior>=100` y
  revert del merge. Corte B → revisión `00118-x92`; corte A → `00117-7pm`.
- **Vercel ya no registra en GitHub los despliegues de producción** (`deployments` con
  `environment=Production`). Los previews sí. Se comprobó por la caché:
  - `/login` se regeneró unos 6 minutos después del merge de A (16:58 UTC) y unos 2 minutos después
    del de B (19:05 UTC).
  - Después de B, el `Etag` cambió y es el mismo en los dos dominios.

  Para la próxima sesión: verificar la web por la caché de `/login` o por el panel de Vercel, no por
  la API de GitHub.

## Qué entró

### Corte A — restos de cc47 y cc47b

- **D-629:** «Totales por línea» en una franja compacta, plegable
  (`components/reports/line-totals-strip.tsx`, `lib/line-totals.ts`).
- **D-630:** Cobranzas «Por cliente» con buscar en el API (`receivablesQuerySchema`,
  `filterReceivablesBySearch`); Excel con el buscar y su nota.
- **D-631:** PDF del Reporte mensual de bobinas con el buscar (`coilMonthPdfSearchNotes`).
- **Excel:** Ventas y margen con la hoja «Por línea»; Producción con «Por OP», «Por pedido» y
  «Total». Ninguna fila suma a otra de su columna.
- **Grillas:** `grid-cols-1` en 19 grillas que contienen tablas. Medido a 1366 y 1920 en 48 pantallas:
  ninguna desborda la página.
- **Limpieza:** sin la invalidación `quotation-stock-shortages`. El endpoint queda vivo (lo usan el
  smoke y cinco E2E).
- **`seed:escenarios`:** caso V1, una boleta manual a crédito en su propio pedido. Los comprobantes que
  no emitió el ERP se anulan con `/annul`.

### Corte B — auditoría legible

- **D-633:** `entityCode`, `entityHref`, `entityDeleted` en cada fila de `GET /audit`
  (`apps/api/src/audit/audit-entity-refs.ts`, una consulta por tipo).
- **D-634:**
  - Buscar por código, id o detalle. El detalle va por SQL de solo lectura y solo con periodos de
    hasta 31 días (`auditTextSearchApplies`).
  - «Filtros»: periodo, usuario, acción y tipo, todo en la URL (`apps/web/src/lib/audit-url.ts`).
  - Excel: `GET /audit/xlsx` (`audit-xlsx.ts`).
  - Los rótulos y el detalle de la auditoría pasaron a `@ayr/shared`.
- **D-635:** el «Historial» abre filtrado y, sin fechas, toma 12 meses.

### Docs (PR de cierre)

D-627 a D-635 en `ARQUITECTURA.md` §0.2 y `DECISIONES.md`; D-606 a D-626 marcadas como ratificadas;
Nubefact e IA fuera del alcance en `PROGRESO.md`; enmiendas cc48 en las especificaciones de tablas
(`cc31-ux-especificacion.md`) y de reportes (`cc32-especificacion.md`); UAT en `docs/uat/cc48.md`;
revisiones en `docs/revision/cc48-{a,b}-*.md`.

## Verificación

- Unitarios: API 3078 (A) y 3148 (B); web 330 (A) y 330 (B; el spec de rótulos pasó a la API). Lint, typecheck y Prettier en verde en
  cada corte.
- E2E:
  - Nuevos: `cc48-restos.spec.ts` y la auditoría en `auditoria-d218.spec.ts`.
  - CI completa en verde en los dos PR (dos shards, Sonar, drift, `seed:escenarios`).
  - Local en modo desarrollo: 8/8 en el corte A. En el corte B, dos tiempos agotados por la compilación
    de páginas en desarrollo: la auditoría pasó al reintento, y `cabecera-y-ancho-cc47b` (D-624), que
    recorre seis páginas en 45 s, pasa en la CI.
- Tiempos de la auditoría, capturas, grillas, propuesta de D-632 y antes/después de `settings.json`:
  `local-data/cc48/INFORME.md` (en el checkout principal).

## Revisiones

- **A:**
  - Autorrevisión: P1 corregido (V1 usaba el pedido de C2).
  - Segundo modelo: P2 corregido (totales en la columna que se suma).
- **B:**
  - Las dos encontraron el mismo P1, corregido: un correlativo inexistente daba 500.
  - P2 corregidos: el tipo en los cambios de precio, el buscar resuelto una vez para el Excel, el
    tope con orden y aviso, el UUID pegado y los decimales del Excel.

Informes en `docs/revision/`.

## Pendiente / para la siguiente sesión

- **El dueño:** ratificar D-627 a D-632, D-634 y D-635; decidir la propuesta de D-632.
- Anotado, sin hacer:
  - «Historial» en compra, corte y orden de producción.
  - Las entidades `supplier_payments`, `inventory_movements` y `raw_material_specs`, que el visor no
    conoce.
  - El buscar por texto compara contra el JSON crudo.
  - Un db-spec que drene páginas con buscar contra Postgres.
  - El subtotal de Ventas por material en la misma columna.
- La copia `ayr_local_cc48c` (carga sintética) se borra al cerrar; `ayr_local` quedó con los casos
  DEMO del seed (V1 incluido).

## Commits

Corte A (PR #187): `1196b37f` buscar en Cobranzas · `737aa863` PDF de bobinas · `bd8d8e8c` hojas de Excel
· `67c6b9c4` franja · `4d61d222` invalidación · `82e6ffc6` V1 · `c37e03ba` franja por ventana ·
`64e4af7c` grillas · `129a8c74` V1 propio · `2d9b1195` Cobranzas (revisión) · `ee52acbb` totales fuera
de la columna · `2a6b9238` E2E · `85703550` prueba del seed.

Corte B (PR #188): `feebbca3` rótulos a shared · `222bf826` códigos y buscar · `84f4e4e5` Excel ·
`29b3377d` pantalla · `a2d15e0d` y `100cb705` revisión · `9b0ed34c` fecha del E2E.
