# Handoff — Ventana RF-S1+HOTFIX (deploy)

## Resumen

Ventana de cierre y deploy que integró **RF-S1/M1** (precios de lista, D-217) con
**HOTFIX-401/M2** (borradores duplicados, D-223) sobre `main`, con el dueño fuera de modo
automático aprobando cada comando con credenciales de BD de prod. RELEASE **`ca6314d`**:
migración D-217 aplicada, API redeployada, push a `main` y web verificado — todo en verde.
`hotfix-401` (M1, 401 al abrir un borrador) **sigue bloqueada**, sin tocar en esta ventana.

## Hecho

- `migrate status`/`migrate deploy`/`migrate status` contra `production`: única pendiente
  `20260916142234_d217_historial_precio_lista` aplicada, 68/68 sin pendientes.
- `migrate diff` post-deploy: no vacío, coincide exactamente con el drift ya documentado
  (Incidente HOTFIX-DESFASE, deuda S3 #1). Sin diferencias nuevas.
- API: `gcloud run deploy` desde worktree `ayr-release-ca6314d` (source, sin flags de
  env/secretos), label `git-sha=ca6314d`. Revisión `ayr-steel-erp-api-00035-rd9` →
  `ayr-steel-erp-api-00036-pj7`, 100% tráfico, mismas 10 variables y mismos recursos que la
  anterior, `/health` `db: ok`.
- `git push origin main`: `f92a3df..ca6314d` (24 commits). CI del push en verde (run
  35175690324). Vercel republicó `ca6314d` sin acción manual; `v2.mareliac.pe/api/health`
  responde `db: ok`.
- Regla git-sha (b) nueva en `CLAUDE.md`: `git diff --quiet <sha> origin/main -- apps
  packages Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml` en vez de
  exigir igualdad exacta de SHA (el cierre agrega commits de solo docs después del deploy).
- `pnpm smoke:prod` desde worktree `ca6314d`: 7/7. Smoke manual del dueño (comprobante,
  botón electrónico, borrador doble, precio inline+revertir, catálogo de coberturas): 5/5 OK.
- `hotfix-401` llegó a `main` por `release/s1-hotfix` (worktree/branch ya apuntaba a `ca6314d`
  antes del push) — el pendiente de la sesión HOTFIX-401 («sin merge ni push») queda resuelto.
- PR #1 (`release/s1-hotfix` → `main`) cerrado sin merge (contenido ya en `main` por push
  directo) y su rama borrada.
- Nuevas decisiones: **D-224** (`check:price-floor` sigue en 0 SKU con `listPricePen`
  cargado, esperado tras D-217 hasta que el dueño cargue precios de lista reales). **D-223**
  ampliada con el bug de `idempotencyKeySchema` (`.max(128)` vs `VarChar(100)`) y la
  verificación por mutación del `FOR UPDATE` (sin el lock, 2-3 borradores en 3/3 corridas).
- `docs/PROGRESO.md`: sección "Ventana RF-S1+HOTFIX — cierre y deploy" + 2 ítems nuevos en
  "Deuda registrada para S3" (guard por línea sin NC, estado de limpieza de ramas Neon).
- `.claude/settings.json`: deny de `git push`/`gh api`/`gh pr merge`/`gh repo sync`/`gh
  workflow run` restaurado (se había quitado para esta ventana).

## Decisiones tomadas

- **D-224** (`docs/ARQUITECTURA.md` §0.2): el piso de precio (D-163) se calcula contra
  `listPricePen`, y sin ese dato cargado el SKU no aparece en `check:price-floor` — no es un
  defecto del reporte.
- Regla git-sha (b) y regla de credenciales de BD de prod solo con el dueño fuera de modo
  automático, ambas en `CLAUDE.md`.

## Bloqueos / pendientes

- **M1 de HOTFIX-401 (401 al abrir un borrador) sigue bloqueada.** Falta la URL/evidencia
  real de producción (id o número del comprobante, `origin`, si tiene `dispatchId`) para
  reproducirla dirigida en vez de a ciegas. No se tocó en esta ventana.
- **No documentado por falta de información**: el brief de cierre mencionaba «el bloqueo del
  clasificador y cómo se resolvió» — no hay rastro de "clasificador" en `docs/` ni en el
  código, y esta sesión arrancó con `/clear` en el paso 2, así que no hay contexto propio
  sobre eso. Si pasó antes del `/clear`, hace falta que el dueño lo dicte para dejarlo en
  `docs/PROGRESO.md`.
- **Deuda de S3 sin ejecutar** (ver `docs/PROGRESO.md`): drift de schema en `production`,
  `deploy-api.mjs`/variables rotas de Cloud Run, guard por línea (`invoicedByItem`) sin
  descontar notas de crédito, limpieza de ramas Neon (nada vencido hoy).
- **Precios de lista sin cargar**: D-217 dio la herramienta (edición inline + carga masiva);
  cargar los `listPricePen` reales es tarea del dueño, no de una sesión de agente.

## Cómo verificar

```
git log --oneline f92a3df..origin/main   # 24 commits de la ventana
git diff --quiet ca6314d origin/main -- apps packages Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml
node scripts/migrations-status.mjs --branch production   # 0 pendientes
node scripts/migrations-diff.mjs --branch production      # drift == deuda S3 #1, nada nuevo
```

```
node scripts/oneoff/20260916-describe-cloud-run.mjs
# latestReadyRevision: ayr-steel-erp-api-00036-pj7, label git-sha=ca6314d
```

```
curl https://v2.mareliac.pe/api/health   # {"status":"ok","db":"ok"}
```

## Siguiente sesión: rf-s2

`ayr-steel-erp-rf-s2` (rama `rf-s2`, visor de auditoría D-218..D-222, 13 commits) tiene su
`merge-base` en `49fe903` — **detrás** de `origin/main` (`ca6314d`) en 24 commits. Antes de
seguir:

1. `git rebase origin/main` sobre `rf-s2` (o `origin/main` sobre el worktree) y resolver
   cualquier conflicto — el visor de auditoría no debería tocar los mismos archivos que
   comprobantes/precios de lista, pero conviene revisar `docs/ARQUITECTURA.md` (ambas ramas
   editaron la tabla §0.2) y `docs/PROGRESO.md` a mano.
2. `pnpm lint && pnpm typecheck && pnpm test` en verde después del rebase.
3. UAT en `demo` (`pnpm env:demo`/`db:demo`/`dev:demo`) antes de proponer otra ventana de
   deploy a `production`.
4. Ventana de deploy propia para `rf-s2`, con el mismo checklist de esta (`git-sha`, `migrate
   diff`, `smoke:prod` desde worktree en el SHA desplegado, credenciales de prod solo con el
   dueño fuera de modo automático).
