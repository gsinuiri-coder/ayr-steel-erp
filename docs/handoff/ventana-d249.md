# Handoff — Ventana de despliegue hotfix D-249/D-250 (2026-09-23)

## 1. Resumen

Se cerró la ventana de despliegue de D-249 (tolerancia de laminado simétrica) y D-250 (filtro
por línea de `/reports/coils`), con autorrevisión registrada (extensión de D-248). PR #13
mergeado a `main` con OK explícito D-232 del dueño (push lo hizo él); merge commit `0e1124b`.
API en Cloud Run, revisión `ayr-steel-erp-api-00042-tdb`, label `git-sha=0e1124b`, 100 % del
tráfico. Web publicado por Vercel sobre el mismo commit (confirmado por status check, no por
inferencia). `pnpm smoke:prod` verde y verificación QA de cierre específica de D-249/D-250
también verde. Sin migración. **Pase cruzado independiente de AGENTS.md §2.2 sigue pendiente.**

## 2. Hecho

- **PASO 0** — Arranque: `AGENTS.md`, `docs/PROGRESO.md`, `docs/handoff/hotfix-d249.md`,
  `docs/revision/rf-s4a-d246.md`. Verificado que la colisión de numeración D-242/D-248 de
  `acc-demo` (commit `a8d320f`) eran números reutilizados para decisiones **distintas**, y que no
  se materializó en ningún log compartido porque esa rama se descartó completa sin mergear. Sin
  corrección necesaria.
- **PASO 1** — Autorrevisión del hotfix por un subagente nuevo sin lectura del handoff de
  implementación: `docs/revision/hotfix-d249-autorrevision.md`. Sin P0. M0 (tolerancia simétrica)
  verificado con cálculo propio en 5 casos y con la suite corrida (21/21 en `mounted-kg.spec.ts`,
  120/120 en `production`+`reports`). M1: se revirtió el fix temporalmente y se confirmó que 3 de
  los 4 tests que caen en rojo son los centinelas nuevos de D-249 (el cuarto es un test
  preexistente de D-246, solo cambia el wording). M2: ni `mountedKgForReport` ni el fix de
  `reports.service.ts` tocan kardex fuera de transacción — el primero es cálculo puro, el segundo
  es un `$queryRaw` de solo lectura. Hallazgo lateral P2 de proceso: `apps/api` resuelve
  `@ayr/shared` contra `dist/`, no `src/` — hay que reconstruir el paquete antes de correr jest
  tras editar `packages/shared/src`, o los resultados son del build viejo.
- **PASO 2** — Rebase de `hotfix-d249` sobre `origin/main` actualizado. Dos conflictos en
  `docs/PROGRESO.md` (mismo patrón que la sesión de limpieza previa: dos ramas agregaron su
  sección en el mismo punto del archivo, sin contenido superpuesto), resueltos conservando ambas
  historias. `pnpm format:check` estaba en rojo en `main` por un commit ajeno al hotfix (2 docs
  sin Prettier); corregido con un commit de formato aparte, sin cambio de contenido. PR #13
  abierto, CI verde (lint/typecheck/unit, E2E 383 passed/3 skipped, análisis estático, smoke +
  migraciones Neon `ci`).
- **PASO 3** — Diagnóstico de solo lectura contra `production`, con autorización explícita del
  dueño por D-234 y la consulta corregida por él antes de correrse (sin filtrar por
  `sales_orders.status`, clasificando por `live_ops`/`total_ops`/`closed_ops`). **Resultado: cero
  pedidos atascados.** Ver detalle en la sección 3 de abajo y en `docs/PROGRESO.md` ("Diagnóstico
  M3 contra producción").
- **PASO 4** — Respaldo Neon `respaldo-pre-d249-20260923` tomado desde `production`
  (`br-steep-night-ae8n7t1k`) a las `2026-09-23T13:27:54Z`, **antes** del push a `main`
  (`2026-09-23T13:31:31Z`, evento `push` de GitHub sobre `0e1124b`) — margen verificado, no
  supuesto. Merge hecho por el dueño (fast-forward). Deploy de API con `pnpm deploy:api
--web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app` desde el worktree de
  `main` en `0e1124b`; verificado contra la revisión activa que los 12 nombres de
  variable/secreto coinciden sin drift. Vercel publicó `0e1124b` (status check `Vercel` →
  `success`, no inferido del push). `pnpm smoke:prod` verde.
- **Cierre QA** (subagente aparte, solo lectura contra producción real): filtro por línea de
  `/reports/coils` verificado con HTTP real (92 filas sin filtro; `metallic-roofing` → 92,
  reconstruye el total; `drywall`/`roofing`/`trading`/`services` → 0, dato real de hoy, no
  síntoma de bug). Tolerancia simétrica verificada con `mounted-kg.spec.ts` (21/21) y con una
  prueba de caja negra contra `packages/shared/dist` reconstruido: caso real (exceso 0,84 %)
  acepta, caso absurdo (4043,952 kg teóricos / 1 kg montado / 0,5 kg declarado) rechaza. Admin
  efímero de QA creado y borrado en la misma sesión. Sin hallazgos nuevos.

## 3. Diagnóstico M3 — la lista pedida en el PASO 3

**Cero pedidos atascados en `production` al momento del diagnóstico (2026-09-23, antes del
merge).** `production_orders` en `production`: 28 filas, **las 28 en `CLOSED`**; cero en `DRAFT`,
`IN_PROGRESS` o `CANCELLED`. Con la query corregida por el dueño (sin depender de
`sales_orders.status`, que `deriveOrderReadiness` nunca lee), los tres mecanismos de M3 dieron 0
filas cada uno, y el `ELSE` (posible cuarto mecanismo detectable por estado de OP) también dio 0.

| caso                                            | filas |
| ----------------------------------------------- | ----: |
| CASO 1 — todo reportado, sin cerrar             |     0 |
| CASO 2 — OP en DRAFT                            |     0 |
| CASO 3 — todas las OP anuladas (SIN_PRODUCCION) |     0 |
| EN CURSO (no matchea los 3 mecanismos)          |     0 |

**El síntoma original queda SIN EXPLICAR.** El dueño reportó el 2026-09-22 un pedido que no
pasaba a `LISTO` al terminar producción. Ninguno de los tres mecanismos de M3 lo reproduce hoy
contra datos reales, y no hay un cuarto mecanismo visible por estado de OP. **La recomendación
para la próxima vez que reaparezca**: no volver a mirar el estado de las OP (ya descartado acá) —
revisar la capa de lectura/presentación de `LISTO`: dónde y cuándo la UI pide/cachea
`deriveOrderReadiness` (`apps/api/src/sales/order-readiness.ts`), si invalida cuando corresponde,
y si algo de esa capa puede mostrar un pedido como no-`LISTO` un rato después de que sus OP ya
cerraron. Script de un solo uso creado, corrido y borrado en esta misma sesión; ninguna escritura
contra `production`.

## 4. Decisiones tomadas

Ninguna decisión nueva en esta ventana. D-249 y D-250 ya estaban registradas en
`docs/ARQUITECTURA.md` §0.2 antes de esta sesión (implementación previa); esta ventana fue
autorrevisión, rebase, diagnóstico y despliegue. El cierre QA post-deploy confirmó lo ya decidido
sin encontrar nada que amerite una fila nueva.

## 5. Bloqueos / pendientes

- **Pase cruzado independiente de AGENTS.md §2.2, pendiente para D-249/D-250** (y sigue
  pendiente también para RF-S4a, D-248). Causa: esquema de un solo agente, sin segundo revisor
  disponible. Acción humana necesaria: cuando haya un segundo agente/sesión disponible, que
  revise `2f98c2b`, `b75ac75` y el resto de la rama con foco en lo que ya señalan
  `docs/revision/rf-s4a-d246.md` y `docs/revision/hotfix-d249-autorrevision.md`.
- **Síntoma original de M3 sin explicar** (ver sección 3). No es un bloqueo de esta ventana —no
  hay nada que cerrar en `production` ahora mismo— pero sigue abierto como investigación.
- **Hallazgo de proceso P2** (no bloqueante): `apps/api` resuelve `@ayr/shared` contra `dist/`, no
  `src/`. Cualquier sesión que edite `packages/shared/src` y corra jest en `apps/api` debe
  reconstruir el paquete primero (`pnpm --filter @ayr/shared run build`) o el resultado es del
  build viejo.

## 6. Cómo verificar

```bash
# Estado del PR y CI
gh pr view 13
gh run list --branch main --limit 3

# Revisión activa de Cloud Run
gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 \
  --format "value(status.traffic[0].revisionName,status.traffic[0].percent,metadata.labels.git-sha)"
# esperado: ayr-steel-erp-api-00042-tdb  100  0e1124b

# Alineación de runtime
git diff --quiet 0e1124b origin/main -- apps packages Dockerfile .gcloudignore package.json \
  pnpm-lock.yaml pnpm-workspace.yaml
# esperado: exit 0

# Smoke de producción (desde un worktree en 0e1124b)
pnpm smoke:prod
# esperado: "Smoke en verde: producción responde y las lecturas principales funcionan."
```

Unitarios: 743 passed / 0 failed en `apps/api` (`pnpm --filter @ayr/api test:cov`). CI del PR #13
y de `main` post-merge: ambos verdes (lint/typecheck/unit, E2E 383 passed/3 skipped, análisis
estático, smoke+migraciones Neon `ci`).

## 7. Siguiente sesión

Sin tarea de código encadenada por esta ventana. Si el dueño autoriza una sesión de revisión
cruzada independiente, esa es la primera tarea concreta pendiente (D-249/D-250 y RF-S4a/D-248).
Si el síntoma original de M3 reapareciera, investigar la capa de lectura/presentación de `LISTO`
antes que el estado de las OP (ver sección 3).
