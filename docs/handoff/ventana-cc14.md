# Runbook: ventana de cc14 (D-372 v1, editar una compra recibida)

**Estado: PREPARADO, sin ejecutar.** Cada paso marcado **[OK]** espera el OK explícito del dueño
(D-251/D-232). El agente propone el comando exacto y espera.

- PR: `<PR>` (rama `cc14/editar-compra-recibida`).
- **No hay migración** y el deploy no escribe datos. Las correcciones de compras las hace el dueño
  después, **por la interfaz**, con motivo y vista previa.
- **Orden:** reacomodar sobre `main` → CI → resumen de D-232 y OK → **API** → smoke → merge
  (publica la **web**) → smoke.
- **La API nueva convive con la web vieja:** solo agrega dos rutas
  (`POST /purchases/:id/received-edit/preview` y `POST /purchases/:id/received-edit`, solo
  ADMINISTRADOR). Ninguna ruta existente cambia de forma ni de comportamiento. La web vieja no
  las llama; la nueva sin la API nueva daría 404 al revisar, por eso la API va primero.
- Nubefact no se toca.

## 0. Reacomodar sobre `main` y CI [agente]

```sh
git fetch
git -C ../ayr-cc14 rebase origin/main
git -C ../ayr-cc14 push --force-with-lease
gh pr checks <PR> --watch
```

Los conflictos esperables son docs (fila D-372, PROGRESO). Si `main` trae el informe de M2b (PR
#78), la fila D-372 se reescribe con el estado de esta versión.

## 1. Antes de empezar [agente]

```sh
gh pr checks <PR>
git rev-parse origin/cc14/editar-compra-recibida     # = <SHA>
git diff --name-only origin/main origin/cc14/editar-compra-recibida -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

La revisión vigente antes del deploy es la vuelta atrás. Se anota acá al empezar.

## 2. Resumen de D-232 y OK del dueño [OK]

Commits, CI de la última corrida, qué se despliega (API y web, sin migración) y riesgo.

## 3. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Verificar el `git-sha`, la revisión al 100 % y que `/health` responda 200. Después,
`pnpm smoke:prod` desde un worktree en `<SHA>` (con `AYR_ENV_SETUP` apuntando al `.env.setup` del
checkout principal).

## 4. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge <PR> --merge
```

Comprobar que el diff de runtime contra `<SHA>` sale vacío y que Vercel terminó en `success`.
Correr `smoke:prod` contra `vercel.app` y contra `--base-url https://v2.mareliac.pe`.

## 5. Primer uso [dueño, administrador]

Guion en `docs/uat/cc14.md`. Recomendación: la primera corrección real, sobre una compra **sin
consumo posterior** y solo con un campo, revisando la vista previa antes de guardar. La vista
previa no escribe nada.

## Vuelta atrás

- **Código:** con la web vieja, volver el tráfico a la revisión anotada en el paso 1. Con la web
  publicada, abrir un PR de revert, mergearlo y después desplegar la API.
- **Datos:** una corrección se deshace **editando de nuevo con el valor anterior** desde la misma
  pantalla (decisión 10 de D-372): deja otra reversa y otro ingreso, con su auditoría, y el saldo y
  el costo vuelven a los del inicio. No hay `--undo` por consola.
- **Respaldo:** no hay uno previsto, porque el deploy no tiene migración ni escribe datos.
