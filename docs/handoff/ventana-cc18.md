# Runbook y handoff: cc18 (D-386, orden único de bloqueos)

**Estado: PR #96 abierto, sin desplegar.** Esta sección se completa en cada paso.

- Rama `cc18/orden-bloqueos` (worktree `../ayr-cc18`), desde `main` `9d88277`.
- **No hay migración** y el deploy no escribe datos. **Sin respaldo Neon** (decisión del dueño en
  el brief): no hay cambio de esquema ni escritura de datos.
- **Orden:** CI verde → UAT del dueño en demo → resumen D-232 y OK → **API** (label `git-sha`) →
  `/health` → smoke → merge del PR (publica la **web**) → Vercel → smoke otra vez. Cada paso
  sensible espera el OK del dueño (D-251).
- **Qué cambia en runtime (solo API; la web no cambia):**
  - el orden en que despacho, reversas, producción, corte, bobinas, confirmar pedido y anular
    compra toman sus bloqueos de fila (D-386). Resultados, mensajes y números iguales;
  - un deadlock o fallo de serialización de Postgres sale como **409** «Otra operación estaba
    usando este inventario. Vuelve a intentarlo.» en vez de 500;
  - una toma de bobinas que ampliaría el conjunto fuera de orden no espera (`NOWAIT`): con
    contención real sale con el mismo 409;
  - `lockCoil` toma la bobina con su agregado (A6, commit `5793cdd`, revertible solo).
- **La API nueva convive con la web vieja:** no hay campos ni caminos nuevos.
- **Salida completa de cada smoke en un archivo** (`local-data/cc18/smoke-cc18-*.log`), antes de
  filtrar.

## 0. CI [agente]

```sh
gh pr checks 96 --watch
```

Incluye `test:db`, con `lock-order.db-spec.ts`: 29 casos y 20 iteraciones por par.

## 1. Demo para el UAT [agente]

Desde `../ayr-cc18`, `pnpm dev:demo` (web 3101 / API 3100). Verificar el commit que corre
(`git -C ../ayr-cc18 rev-parse --short HEAD`, igual al último del PR). Guion: `docs/uat/cc18.md`.

## 2. Antes de la ventana [agente]

```sh
git fetch
gh pr checks 96
git rev-parse origin/cc18/orden-bloqueos            # = <SHA>
git diff --name-only origin/main origin/cc18/orden-bloqueos -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

Antes de cc18, producción estaba en `ayr-steel-erp-api-00082-rlx` (`df5929f`). Esa revisión es la
vuelta atrás.

## 3. Resumen de D-232 y OK del dueño [OK]

## 4. Deploy de la API [OK]

Desde el checkout principal, que tiene `.env.setup`:

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Verificar el label `git-sha=<SHA corto>`, la revisión al 100 % y `/health` 200. Correr
`pnpm smoke:prod` desde `../ayr-cc18` en `<SHA>`, con `AYR_ENV_SETUP` y la salida completa en un
archivo.

## 5. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge 96 --merge
```

Verificar:

- diff de runtime contra `<SHA>` vacío;
- Vercel `success`;
- smoke en `vercel.app` y en `v2.mareliac.pe`, con la salida completa en un archivo.

## Vuelta atrás

- **Código, antes del merge:** volver el tráfico a `00082-rlx`.
- **Código, después del merge:** PR de revert, merge y redeploy de la API.
- **Solo A6:** si lo raro aparece en planta, se revierte `5793cdd` (`git revert 5793cdd`) y se
  redespliega la API.
- **Datos:** no aplica. cc18 no escribe datos ni cambia el esquema.

## Cierre [agente]

- Demo apagado.
- `local-data/` de `../ayr-cc18` copiada al checkout principal y verificada.
- Base local `ayr_local_e2e_cc18` borrada (`DROP DATABASE`, Docker).
- Worktree, rama local y rama remota borrados.
- Checkout principal en `main`.
