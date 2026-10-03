# Runbook: ventana de cc15a (D-372, sesión 2, primera parte)

**Estado: PREPARADO, sin ejecutar.** Cada paso marcado **[OK]** espera el OK explícito del dueño
(D-251/D-232). El agente propone el comando exacto y espera.

- PR: `<PR>` (rama `cc15/editar-compra-sesion2`).
- **No hay migración** y el deploy no escribe datos. Las correcciones las hace el dueño después,
  por «Editar compra», con motivo y vista previa.
- **Orden:** reacomodar sobre `main` → CI → resumen de D-232 y OK → **API** → smoke → merge
  (publica la **web**) → smoke.
- **La API nueva convive con la web vieja:**
  - el plan de la vista previa suma campos (`adjustment`, `warnings`) y un camino nuevo
    (`COST_ADJUST`). La web vieja no conoce ese camino: mostraría la fila sin etiqueta. Por eso
    **se mergea enseguida** después del smoke de la API;
  - el guardado acepta `idempotencyKey` opcional; la web vieja no lo manda y no cambia nada;
  - la anulación de compras se afloja solo para ítems donde la compra ya no tiene nada vigente.
- Nubefact no se toca.

## 0. Reacomodar sobre `main` y CI [agente]

```sh
git fetch
git -C ../ayr-cc15 rebase origin/main
git -C ../ayr-cc15 -c http.version=HTTP/1.1 push --force-with-lease
gh pr checks <PR> --watch
```

## 1. Antes de empezar [agente]

```sh
gh pr checks <PR>
git rev-parse origin/cc15/editar-compra-sesion2     # = <SHA>
git diff --name-only origin/main origin/cc15/editar-compra-sesion2 -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

La revisión vigente antes del deploy es la vuelta atrás. Se anota acá al empezar.

## 2. Resumen de D-232 y OK del dueño [OK]

## 3. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Verificar `git-sha`, revisión al 100 % y `/health` 200; `pnpm smoke:prod` desde `../ayr-cc15` en
`<SHA>` con `AYR_ENV_SETUP`.

## 4. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge <PR> --merge
```

Diff de runtime contra `<SHA>` vacío, Vercel `success`, smoke en `vercel.app` y `v2.mareliac.pe`.

## Vuelta atrás

- **Código:** con la web vieja, volver el tráfico a la revisión del paso 1. Con la web publicada,
  PR de revert, merge y redeploy de la API.
- **Datos:** un ajuste proporcional se deshace volviendo a editar con el precio anterior (otro
  ajuste, sobre lo que quede en ese momento; la vista previa explica la diferencia si hubo
  consumo entre medio). No hay `--undo` por consola.
- **Respaldo:** no hay uno previsto: sin migración y sin escritura de datos en el deploy.
