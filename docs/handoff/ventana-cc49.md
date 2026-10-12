# Ventana cc49 — Qué commit está publicado e «Historial» en compra, corte y OP

2026-10-12, Lima (tarde). Dos cortes, cada uno con su PR y merge de a uno, más el cierre de docs. Sin
migraciones ni SQL contra producción. Decisiones D-636 y D-637, provisionales. El dueño decidió
además que D-632 no se aplica y que PED-000049 queda sin acción.

## En producción

- **Corte A (PR #190, merge `a0efee22`):** API `ayr-steel-erp-api-00120-clh` (`git-sha=9cf2a91b`),
  desplegada antes del merge, y web de `a0efee22`.
- **Corte B (PR #191, merge `9e3f0bcc`):** solo web. La API sigue en `00120-clh`.
- `smoke:prod` en verde en los dos dominios tras cada corte, con la verificación nueva:
  - Corte A: `--expect-sha a0efee22 --expect-api-sha 9cf2a91b`. La web publicó en el intento 8, a
    unos 2 minutos (antes, el build viejo respondía HTML porque no tenía `/version`).
  - Corte B: `--expect-sha 9e3f0bcc`. La web publicó en el intento 8.
  - Salidas completas en `local-data/cc49/smoke-*.log`.
- **Vuelta atrás:**
  - Corte B: revert del merge.
  - Corte A: `gcloud run services update-traffic ayr-steel-erp-api --to-revisions=ayr-steel-erp-api-00119-dkj=100`
    y revert del merge.
  - La revisión `00119-dkj` no trae `sha` en el health: después de volver a ella, no se pasa
    `--expect-api-sha`.

## Qué entró

### Corte A — D-636

- `apps/web/src/app/version/route.ts`, `lib/build-info.ts`: `{ sha, builtAt }`, `no-store`. El sha
  sale de `VERCEL_GIT_COMMIT_SHA` y queda fijo en el build (`next.config.ts#env`).
- `middleware.ts`: `/version` abierta con y sin sesión (`OPEN_PATHS`, comparación exacta).
- `turbo.json`: `VERCEL_GIT_COMMIT_SHA` en el `env` de `build`.
- `health.controller.ts`: campo `sha` desde `GIT_SHA`, que `deploy-api.mjs` pone igual al label.
- `scripts/smoke-version.mjs` (comparador, espera, `gitContains`) y `smoke-prod.mjs`:
  - `--expect-sha` (por defecto, `origin/main`) y `--expect-api-sha`.
  - Un solo tope de 10 minutos para los dos dominios.
- Flujo de cierre: AGENTS.md §3.2, `ayr-cierre` (paso 8), `ayr-ventana` (paso 8) y ENTORNOS.

### Corte B — D-637

- `AuditHistoryLink` en `compras/[id]`, `corte/[id]` y `produccion/[id]`, antes de `HeaderActions`.

## Verificación

- Lint (todo el repo), typecheck, Prettier y unitarios en verde. API: 3149 de 3152, con 2
  omitidos y un timeout suelto de `auth.service.spec` (hash de contraseña con la máquina cargada),
  que corrido solo da 15 de 15. Web: 49 archivos en verde. `test:scripts`: 98 en verde con la
  primera versión del comparador, y el comparador final da 16 de 16.
- Un `next build` con `VERCEL_GIT_COMMIT_SHA` falso: `/version` devolvió ese sha, `no-store`, y
  respondió 200 con cookie de sesión, mientras `/pedidos` seguía en 307.
- E2E nuevos, en local sobre base propia (`ayr_local_e2e_cc49`):
  - `version-d636.spec.ts`: 3 de 3.
  - `historial-cc49.spec.ts`: 1 de 1, con un tope de 300 s porque `next dev` compila en frío.
  - La suite completa la corrió la CI, en verde en los dos PR (2 shards, Neon ci y Sonar).
- Capturas en `local-data/cc49/capturas/`, a 1366×768: compra, corte y OP antes y después, y la
  auditoría abierta desde cada uno (datos de `seed:escenarios` en `ayr_local`).
- El preview de Vercel está protegido (Vercel Authentication). Sin tokens no se pudo leer su
  `/version`; la prueba en Vercel fue el smoke de producción.

## Revisiones

- **Corte A:**
  - Autorrevisión: 2 P2 corregidos.
    - Un merge de otra sesión daba un falso rojo: ahora se acepta un commit posterior que contiene
      al esperado.
    - El tope era por dominio: ahora es uno solo para los dos.
  - Segundo modelo: 2 P2 corregidos (tope por lectura; uso de `--expect-sha`).
  - P3 corregidos: «dev» falla al instante, `--expect-sha=` se rechaza, prueba del middleware y E2E
    solo en local.
  - La CI encontró un `||` que mi lint local no mostró (corregido en `9cf2a91b`).
- **Corte B:**
  - Ninguna revisión con P0 ni P1.
  - El P2 de la autorrevisión (los pagos no salen en el «Historial» de la compra) es anterior al corte
    y pediría auditoría nueva, que el brief excluye: queda abajo.
  - P3 corregidos en el E2E y en el orden de los comentarios.
- Informes en `docs/revision/cc49-{a,b}-*.md`.

## Vercel y GitHub (diagnóstico, solo lectura)

- Vercel **sí** registra los despliegues de producción en GitHub: 37 de los últimos 100, entorno
  `Production`, todos con `success`.
- Lo de cc48 fue un atraso del aviso. En `cebdb94f` llegó 58 minutos después del merge y en `31adda6f`,
  31 minutos después, en los dos casos sin el `pending`. Los demás merges llegan en 20 s a 2,3 minutos.
  En cc49: `a0efee22`, `pending` a los 4 s y `success` a los 2,5 minutos; `9e3f0bcc`, igual.
- No hay ajuste de la integración que corregir, y no se tocó nada.
- Para ver el porqué en el panel (opcional, el dueño):
  1. vercel.com → proyecto de la web → Deployments, filtrado por Production: comparar «Created» con
     «Ready» de `cebdb94f` y `31adda6f`, y ver si hubo un redeploy del mismo commit.
  2. Settings → Git: el repo conectado es `gsinuiri-coder/ayr-steel-erp`.

## Acciones que no dejan registro con el id del documento (sin auditoría nueva, por el brief)

Líneas en `apps/api/src`, en la firma de la función.

1. **Compra, pagos a proveedor:** `purchases/purchases.service.ts` `addPayment` (:1271) y
   `reversePayment` (:1375) auditan en `supplier_payments` con el id del pago. Ese tipo tampoco está en
   el visor.
2. **Compra, lote del importador:** `imports/purchase-import.service.ts` `confirm` (:395) y `undo`
   (:561) usan la entity `purchases` con el id del lote, que no es una compra. Cada compra del lote sí
   tiene su propio registro.
3. **Compra, costo de importación sobre otra compra:** `purchases.service.ts` `applyLandedCost`
   (:969) solo audita en `coils`.
4. **Orden de corte, factura del corte:**
   - Vincularla al crear la compra de servicio: `createInTx` (:215), con `relatedCuttingOrderId`.
   - Imputar su costo: `applyCuttingOrderCost` (:1107).
   - Las dos escriben en `purchases` y en `coils`, nada en `cutting_orders`.
5. **OP, borradores de reporte:** `production/roofing-drafts.service.ts` `add` (:104), `update`
   (:143) y `remove` (:168) no auditan. El commit de los borradores sí audita.
6. **OP, anular el pedido:** `sales/sales-orders.service.ts` `cancel` (:2482) anula las OP en borrador
   y solo audita en `sales_orders`.
7. **OP, cambiar la cantidad de la línea:** `sales/sales-order-edits.service.ts`
   `resizeUnstartedInTx` (:1034) y `followPlan` (:1512) reescriben la reserva o el plan de la OP y
   solo auditan en `sales_orders`.

## Pendiente / para la siguiente sesión

- **El dueño:**
  - Ratificar D-636 y D-637.
  - Decidir si se auditan con el id del documento las acciones de arriba.
  - Opcional: revisar en el panel de Vercel el atraso de cc48.
- Anotado, sin hacer:
  - Si `/version` todavía no existe o devuelve HTML, el smoke muestra el error de JSON
    («Unexpected token '<'») en vez de «todavía no publicado». Es cosmético: reintenta igual.
  - El E2E de «Historial» no prueba que otro rol no vea el botón (el componente es compartido).
  - En la compra, «Historial» queda unos 2 a 4 px más arriba que «Más opciones» (`items-start`),
    como en bobina.
- La base `ayr_local_e2e_cc49` se borra al cerrar.

## Commits

- Corte A (PR #190):
  - `f36a361d` health con sha
  - `3da8ca8d` `/version`
  - `3fa98aeb` smoke
  - `94a99fe7` revisión
  - `9cf2a91b` lint
- Corte B (PR #191):
  - `261e3ecc` «Historial»
  - `002c9911` revisión y E2E
