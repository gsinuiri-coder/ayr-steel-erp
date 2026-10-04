# Runbook: ventana de cc15b (D-372, sesión 2, segunda parte)

**Estado: EJECUTADA el 2026-10-03 (hora de Lima), sin incidencias.** Cada paso tuvo el OK del
dueño (D-251/D-232); el detalle está en «Ejecución», al final.

- PR: `#88` (rama `cc15b/reemplazo-con-reserva`), desplegado desde `99e76b0`.
- **No hay migración** y el deploy no escribe datos. Las correcciones las hace el dueño después,
  por «Editar compra», con motivo y vista previa.
- **Orden:** reacomodar sobre `main` → CI → resumen de D-232 y OK → **API** → smoke → merge
  (publica la **web**) → smoke.
- **Qué cambia en runtime:**
  - `InventoryService` gana la puerta `replaceEntry`; `record` y `reverse` pasan a compartir con
    ella el mismo camino interno (sin cambio de comportamiento: los mismos tests de siempre en
    verde);
  - «Editar compra» corrige precio y cantidad con `replaceEntry`: ahora también con reserva activa
    (si la reserva cabe en el saldo final) y con otra compra posterior del mismo producto;
  - la vista previa bloquea el cambio de color o espesor de una bobina que respalda material
    prometido;
  - anular una compra de producto terminado ya no se bloquea por una **entrada** ajena posterior
    (P2-2). Foto READ ONLY de producción del 2026-10-03: ninguna compra pasa de anulable a
    bloqueada; solo E001-1766 pasa el guardrail, y la siguen parando sus reservas.
- **La API nueva convive con la web vieja:** no hay campos ni caminos nuevos en el plan (los avisos
  nuevos viajan en `warnings`, que la web de cc15a ya muestra). Se mergea después del smoke igual.
- **Salida completa de cada smoke en un archivo** (`smoke-cc15b-*.log`), antes de filtrar.
- Nubefact no se toca.

## 0. Reacomodar sobre `main` y CI [agente]

```sh
git fetch
git -C ../ayr-cc15 rebase origin/main
git -C ../ayr-cc15 -c http.version=HTTP/1.1 push --force-with-lease
gh pr checks <PR> --watch
```

La CI incluye el paso nuevo «Kardex contra la base (test:db)» en el job de E2E.

## 1. Antes de empezar [agente]

```sh
gh pr checks <PR>
git rev-parse origin/cc15b/reemplazo-con-reserva     # = <SHA>
git diff --name-only origin/main origin/cc15b/reemplazo-con-reserva -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

## 2. Resumen de D-232 y OK del dueño [OK]

## 3. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Verificar `git-sha`, revisión al 100 % y `/health` 200; `pnpm smoke:prod` desde `../ayr-cc15` en
`<SHA>` con `AYR_ENV_SETUP`, con la salida completa a un archivo.

## 4. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge <PR> --merge
```

Diff de runtime contra `<SHA>` vacío, Vercel `success`, smoke en `vercel.app` y `v2.mareliac.pe`
(salida completa a archivo).

## Vuelta atrás

- **Código:** antes del merge, volver el tráfico a la revisión del paso 1. Después, PR de revert,
  merge y redeploy de la API.
- **Datos:** una corrección se deshace volviendo a editar con el valor anterior (otro
  `replaceEntry`). En producto terminado con otras existencias, el promedio puede quedar a
  ±0,0001 (la vista previa lo avisa).
- **Respaldo:** no hay uno previsto: sin migración y sin escritura de datos en el deploy.

## Ejecución (2026-10-03)

- **Antes:** UAT del dueño en demo sobre `99e76b0`, confirmado. CI 37172441456 en `99e76b0`:
  success (lint, typecheck y unitarios; `test:db`; E2E; smoke de Neon `ci`, verde al relanzarlo
  tras dos cancelaciones por corridas paralelas; SonarCloud). Diff de migraciones y
  `schema.prisma` vacío. Producción estaba en `ayr-steel-erp-api-00079-gwg` (`ff5fd2b`).
- **Paso 1, API:** `pnpm deploy:api --web-origin …` desde el checkout principal en
  `--detach 99e76b0`. Revisión `ayr-steel-erp-api-00080-wgf`, `git-sha=99e76b0`, 100 % del
  tráfico, `/health` 200. `pnpm smoke:prod` desde `../ayr-cc15` en `99e76b0`: 8/8 ok (salida
  completa en `local-data/ayr-cc15/smoke-cc15b-api.log`).
- **Paso 2, merge:** `AYR_OWNER_PUSH=1 gh pr merge 88 --merge` → `80cb7ed`. Diff de runtime
  contra `99e76b0` vacío; Vercel `success`. Smoke 8/8 en `ayr-steel-erp-web.vercel.app` y 8/8 en
  `v2.mareliac.pe` (`smoke-cc15b-vercel.log`, `smoke-cc15b-v2.log`, misma carpeta).
- **Paso 3, cierre:** demo apagado; `local-data` de `../ayr-cc15` y `../ayr-c15x` copiada al
  checkout principal y verificada (mismos archivos y tamaños); worktrees, ramas locales y la rama
  remota `cc15b/reemplazo-con-reserva` borrados.
- **Respaldo posterior, pedido por el dueño:** `respaldo-pre-replaceentry-20261003`
  (`br-rapid-river-ae59y2vw`, padre `production` `br-steep-night-ae8n7t1k`), `ready`. El dueño
  no usa «Editar compra» con reserva activa ni con otra compra posterior hasta tenerlo: ya está.
