# Ventana cc53 — recosteo del promedio por fecha, corrección única y nada atrasado en negativo

2026-10-14, Lima. Tres PR, cada uno con su despliegue, más el cierre de docs. Decisiones D-649..D-652, ratificadas por
el dueño el mismo día (con D-642..D-648). **Una migración** (`20261015_inventory_recost`) y **una escritura masiva**
(`recosteo:historico --execute --confirm-production`), las dos con OK del dueño por nombre. Sin SQL contra producción.

## En producción

- **Corte A (PR #202, merge `c10483a2`):**
  - Respaldo `respaldo-pre-cc53-20261014` (`br-flat-rice-aetbs1e3`).
  - Migración con `pnpm db:prod` (antes: pendiente solo la de cc53; después: «Database schema is up to date!»;
    `migrate diff` = `drift-esperado.sql`).
  - API `ayr-steel-erp-api-00126-xtp` (`git-sha=32eb00f9`), antes del merge. `smoke:prod --expect-sha c10483a2
--expect-api-sha 32eb00f9` en verde en los dos dominios.
- **Hotfix de topes (PR #204, merge `7755b6f4`):** API `00127-758` (`e33cc342`); smoke en verde. La demo se actualizó a
  ese commit.
- **Corte B (PR #203, merge `7fd1a24b`):**
  - Demo: la rama ya tenía la migración; dry-run (48 ajustes, residuo 0), `--execute` («coincide al céntimo»), segundo
    dry-run 0. Capturas y vistas previas en `local-data/cc53/demo/`.
  - Producción: dry-run idéntico al de demo en ajustes, SKU, inventario y comprobantes; respaldo
    `respaldo-pre-cc53b-20261014` (`br-hidden-sound-ae4ue3jd`); `--execute` (48 ajustes «Recosteo histórico cc53»),
    «coincide al céntimo»; segundo dry-run 0; smoke en verde.
  - API `00128-9nl` (`7fd1a24b`) para alinear el `git-sha` con main (el corte B agrega archivos en `apps/api` que el
    runtime no usa); smoke con `--expect-api-sha 7fd1a24b` en verde.
- **Vuelta atrás:**
  - API: `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=<revisión anterior>=100` y revert del
    merge. La columna `recost_of_id` puede quedar: la API anterior a cc53 no la lee.
  - Recosteo histórico: no se «deshace» editando; si hiciera falta, desde `respaldo-pre-cc53b-20261014` con decisión del
    dueño.

## Qué entró

- **D-649:** `recost-engine.ts` (motor puro), `inventory-recost.ts` (plan, solo lecturas, `stockUpToDate`,
  `qtyRowsOf`), `InventoryService.recostForward` (puerta nueva de la regla dura 8; `lockRecostItems` con `NOWAIT`),
  `record`/`reverse`/`adjustCost` con fecha atrasada, costo efectivo en `reverse`. Lectores: `findMovements` pliega el
  recosteo («recosteado», también Excel y hoja del cliente), PEPS lo ignora, `document-profitability`,
  `sales-by-material` y `sales-margin` (también la rama de devoluciones y el material de planta) lo atan por
  `recost_of_id`; `production-summary` lo cuenta como costo. 26 consultas de dominio excluyen los recosteos.
  Auditoría `inventory.recost` / `inventory.recost-pending` / `inventory.recost-historic`.
- **D-650:** fuera `BACKDATE_COST_MISMATCH` y `acceptBackdatedCost` en API, shared y web.
- **D-651:** `pnpm recosteo:historico` (`recost-historic-cli.ts`, `recost-historic.ts`) e `pnpm inspect:cc53`.
- **D-652:** `fitsWithoutNegative` / `firstValidDate`, `assertNoNegativeAtDate`, `reverse(…, { reentry: true })`.
- **Hotfix:** `common/transaction-options.ts` (`KARDEX_TX_OPTIONS`) y su centinela.
- **AGENTS.md:** regla dura 8 (puerta nueva, D-649/D-650/D-652), hora de Lima con Node (§3.5), logs en
  `local-data/<pieza>/` (§3.5).

## Verificación

- Lint, typecheck y Prettier en verde. Unitarias de API 3 452; web 345.
- db-spec en base propia: 14 suites, 169 pruebas (`recost.db-spec` 13/13 con el caso de cc52 exacto, la tabla
  del informe al dueño; par nuevo en `lock-order.db-spec`: 20 carreras sin deadlock).
- E2E locales con builds de producción: 61/61 en 10 specs; después de D-652, `restaurar-bobina-d375` y
  `refechar-despacho-d288` 9/9. CI completa en verde en los tres PR.
- Medido contra Neon `ci` (PC, transacción revertida): recosteo de 10 salidas 2,37 s; devolución con recosteo 2,72 s.

## Revisiones

- Corte A: autorrevisión y segundo modelo (`docs/revision/cc53-a-*.md`). Sin P0. P1 corregidos: recosteos visibles para
  las guardas del dominio, reapertura de bobina, devolución final, resumen de producción, bloqueos fuera de orden. P2
  corregidos: ruido de redondeo, saldo cero, lectura bajo lock de la devolución, material de planta; el de negativos a
  una fecha pasó a ser D-652 por decisión del dueño.
- D-652, hotfix y corte B: segundo modelo **posterior al despliegue** (`docs/revision/cc53-b-segundo-modelo.md`): sin
  P0 ni P1; 7 P2 y 4 P3, **anotados para una pieza siguiente** (no cambian lo ejecutado): D-652 se pide en dos pasos
  (primero el acuse de D-124); dos cálculos de «primera fecha válida» (plan de despacho y D-652) que pueden divergir; la
  web solo trata el código de D-652 en el despacho del comprobante; `qtyRowsOf` lee el kardex completo sin presupuesto
  de consultas; el centinela de topes solo ve llamadas directas; `recosteo:historico --execute` debería abortar sin una
  vista previa del mismo sha; la transacción del recosteo histórico bloquea los SKU hasta 600 s (horario muerto).

## Pendiente / para la siguiente sesión

- **El dueño:** UAT en `docs/uat/cc53.md`.
- **Auditoría siguiente:** (a) Rentabilidad del comprobante y Ventas y margen usan bases de costo distintas para
  coberturas; (b) un pedido con un despacho «sin comprobante declarado» (en el informe al dueño).
- **Neon: 10 de 10.** Antes de crear otra rama, proponer al dueño cuáles borrar (el dueño las borra).
- **P3 anotados:** el plan carga el kardex completo de cada ítem antes de mirar el tope; tras un «recosteo pendiente»,
  una segunda retrofecha deja huecos hasta correr `recosteo:historico`; los costos guardados en reportes de producción,
  OP y devoluciones quedan con el valor de su momento; la herramienta de fecha de D-285 no dispara recosteo; la edición
  de precio de una compra recibida con consumo sigue ajustando con fecha de hoy (cc15); el diálogo de retrofecha de
  `comprobante-detalle-view` y `dispatch-at-issue-date` ya no puede abrirse (código muerto inofensivo); SonarCloud marcó
  «cancelado» el procesamiento del PR #202 aunque el análisis terminó bien.
- La sesión cc54 (NC por motivo SUNAT) parte del main que deja este cierre.

## Commits

- Corte A (PR #202): `78d996e8` recosteo y fin de D-648; `1a4db167` revisiones; `e2f9424d` Prettier; `017cd8d1` spec;
  `194d0632` D-652; `32eb00f9` D-652 juzga el estado final.
- Hotfix (PR #204): `e33cc342`.
- Corte B (PR #203): `3e210321` recosteo histórico; `e6ae29c1` tsconfig.cli; `edac09a6` inspect:cc53.
