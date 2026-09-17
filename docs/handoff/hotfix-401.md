# Handoff — HOTFIX-401

## Resumen

Dos bugs de producción, ambos en el comprobante en borrador. **M2 (borradores duplicados)
cerrada y verificada.** **M1 (401 al abrir un borrador) sigue bloqueada**: el brief no traía
la URL de la petición que falla, y no se pudo reproducir sin ella. Toca solo `apps/api` y
`apps/web`/`packages/shared` (M2); nada de M1 se llegó a escribir. `hotfix-401` (worktree
propio, desde `origin/main` = prod) tiene 4 commits locales, **sin push**.

## Hecho

- **M2 — un pedido no admite un segundo borrador que exceda su total** (D-223, antes D-214):
  `apps/api/src/invoicing/invoicing.service.ts` (`createInTx`: `idempotencyKey` + tope;
  `discardDraft`: `reason` obligatorio), `packages/shared/src/schemas/invoicing.ts`
  (`documentBalance` excluye `DRAFT`; `discardDraftSchema`), migración
  `20260916180000_hotfix401_no_duplicate_drafts` (dos índices únicos parciales), frontend
  (`comprobante-detalle-view.tsx`, `nuevo-comprobante-view.tsx`), E2E
  (`hotfix-401-borradores-duplicados.spec.ts`, 7 casos, más 2 specs existentes actualizados
  al contrato nuevo de `discardDraft`).
- **M1 — investigación sin reproducir**: guard de `GET /invoicing/documents/:id` sin
  cambios; `issueDateChanges` resguardada en el único DTO builder; sin colisión de cache
  lista/detalle; 3 intentos de reproducción (borrador simple, con `dispatchId`, como
  ADMINISTRADOR y VENDEDOR) sin 401 ni error.

## Decisiones tomadas

- **D-223** (registrada como D-214; renumerada al integrar con RF-S1, que ya usaba ese número): idempotencia + tope por pedido + `documentBalance` excluye `DRAFT` + `reason`
  obligatorio en `discardDraft` + dos índices únicos parciales (excluyendo `NOTA_CREDITO`).

## Bloqueos / pendientes

- **M1 sigue bloqueada.** Necesito la URL real de la petición que da 401 (o, si no está a
  mano, el id/número del comprobante que falla en producción, su `origin`, y si tiene
  `dispatchId`) para retomarla con una reproducción dirigida en vez de seguir probando
  combinaciones a ciegas.
- **La migración de M2 no se aplicó contra `dev`/`demo`/`production`**, solo contra el
  Postgres local (`ayr_local_e2e`). Acción humana: antes de `pnpm db:deploy`/`db:prod`,
  correr la consulta de solo lectura de `docs/PROGRESO.md` (sección de esta sesión) contra
  `production` y descartar desde la UI cualquier borrador sobrante que aparezca — la
  migración además aborta sola con mensaje claro si encuentra duplicados al aplicarse.
- **`hotfix-401` no está mergeada ni pusheada.**

## Cómo verificar

Desde `C:\Users\User\Documents\workspace\ayr\ayr-steel-erp-hotfix-401` (worktree de esta
sesión, rama `hotfix-401`):

```
pnpm lint && pnpm typecheck && pnpm test && pnpm format:check
# 32 test suites, 431 tests, 0 fallidos
```

```
pnpm exec playwright test e2e/tests/hotfix-401-borradores-duplicados.spec.ts --reporter=list
```

```
git log --oneline f92a3df..HEAD   # 4 commits de esta sesión
git status --porcelain             # limpio
git diff origin/main --stat        # nada fuera de lo esperado
```

## Siguiente sesión

Primera tarea: conseguir la URL/evidencia real del 401 y retomar M1 con reproducción
dirigida en vez de exploratoria. Si el dueño decide integrar `hotfix-401` antes de que M1
esté resuelta, M2 está completa y verificada de forma independiente — no depende de M1 ni
al revés.
