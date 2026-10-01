# Runbook — deploy de cc06 (D-368..D-371)

**Estado: PREPARADO, sin ejecutar.** Ventana **nocturna**. Cada paso marcado **[OK]** espera el OK
explícito del dueño en la sesión (D-251/D-232). El agente propone el comando exacto y espera; no
encadena comandos de producción.

- PR: https://github.com/gsinuiri-coder/ayr-steel-erp/pull/65, rama `feat/cc06-ui`.
- **Sin migración.** No hay `db:prod`, `migrate diff` ni `migrate deploy`. El respaldo Neon
  pre-ventana es opcional y lo decide el dueño por nombre, porque no hay migración ni escritura
  masiva. Si se hace, el nombre sugerido es `respaldo-pre-cc06-<fecha>`.
- **Orden obligatorio: API → web.** La web nueva con la API vieja rompe el modal de Ventas por
  material (los campos `typeKey`, `theoreticalKg`, `meters`, `avgCostPen` y `documents` de cada
  bobina no llegan) y la edición de líneas de compra (la ruta no existe). Al revés no rompe nada,
  porque la web vieja ignora los campos nuevos. Por eso **el merge a `main` va después del deploy
  de la API**: un push a `main` publica la web en Vercel.
- Tiempos de referencia de ventanas anteriores, no medidos para esta: API ≈ 4–5 min, Vercel ≈ 2–3
  min, smoke ≈ 1 min.

## 0. Antes de empezar [agente]

Desde el checkout principal (`ayr-steel-erp`), que es el único con `.env.setup`:

```sh
git fetch
gh pr checks 65                                  # todo verde, Sonar incluido
git rev-parse origin/feat/cc06-ui                # = <SHA>, el que se despliega
git log --oneline origin/main..origin/feat/cc06-ui
git diff --name-only origin/main origin/feat/cc06-ui -- apps/api/prisma/migrations apps/api/prisma/schema.prisma
                                                 # vacío: si aparece algo, se para
```

- Si `main` avanzó, se rebasa la rama, se espera la CI nueva y se vuelve a empezar.
- **[OK]** Anotar la revisión vigente de la API para volver atrás:

```sh
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

## 1. Deploy de la API [OK]

```sh
git checkout --detach <SHA>                      # el script etiqueta con el HEAD
pnpm deploy:api                                  # lleva --update-labels git-sha=<SHA corto>
git checkout main
```

## 2. Verificar la API [agente; el describe con OK]

```sh
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

- Hay que verificar tres cosas:
  - `git-sha` es igual al `<SHA>` corto: **el SHA activo coincide**;
  - hay una revisión nueva con el 100 % del tráfico;
  - `/health` responde 200.
- Correr `pnpm smoke:prod` desde un worktree en `<SHA>`. Tiene que salir verde con **web vieja +
  API nueva**. Nunca `e2e:prod` (D-126).
- **Si algo falla acá:** volver atrás (§Vuelta atrás) y parar. Nada se tocó en datos.

## 3. Merge a `main`, publica la web [OK]

Resumen D-232 de la entrega:

- commits de la PR #65;
- sin migración;
- D-368..D-371 (D-372 en backlog);
- autorrevisión y segundo modelo con todos los P0/P1 corregidos;
- CI verde: suite E2E completa en el runner;
- revisión del dueño hecha.

```sh
gh pr merge 65 --merge                           # merge commit: el árbol de main queda = <SHA>
git fetch
git diff --quiet <SHA> origin/main -- apps packages Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml
                                                 # exit 0: la API desplegada coincide con main
```

Esperar el deploy de Vercel con `gh run list --branch main --limit 1` y el estado de Vercel.

## 4. Smoke de producción y verificación a ojo [agente + dueño]

```sh
pnpm smoke:prod                                  # desde el worktree en <SHA>, solo lectura
```

Mirar sin escribir, siguiendo `docs/uat/cc06.md`:

- **Reportes → Ventas por material** (mes anterior):
  - no está el botón «Bobinas usadas»;
  - al hacer clic en una fila se abre el modal de dos niveles;
  - la suma de los teóricos de las bobinas da el peso teórico de la fila;
  - una cumbrera o un canal muestran teórico distinto de cero.
- **Comercial → Importar cotizaciones:** subir el último Excel ya importado, solo preview, sin
  confirmar. Sus filas salen en rojo («cotización relacionada»).
- **Compras:** una compra en borrador muestra **Editar/Eliminar** por línea; una recibida no los
  muestra. No pulsar en producción.

## 5. Después de la ventana [agente]

- Registrar tiempos y resultados medidos en `docs/PROGRESO.md`.
- **Borrar el stash** `cc06-wip-duplicados-import-2026-09-29` del worktree `../ayr-cc06`, solo
  después del merge: `git -C ../ayr-cc06 stash list` para ubicarlo por nombre y luego
  `git -C ../ayr-cc06 stash drop stash@{N}`.
- Cerrar el worktree `../ayr-cc06`. Antes, copiar su `local-data/` al checkout principal y
  verificar la copia (AGENTS §4).

## Vuelta atrás

- **Solo API**, si la web todavía no se publicó: volver el tráfico a la revisión anotada en el
  paso 0. **[OK]**

```sh
cmd /c gcloud run services update-traffic ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --to-revisions <revisión anterior>=100
```

- **Con la web ya publicada:** revertir el merge en `main` (PR de revert) y después volver la API.
- No hay datos que revertir: la entrega no tiene migración ni escrituras masivas. Lo que el
  usuario haya hecho después del deploy queda en `audit_log`: líneas de compra editadas, que son
  datos legítimos.

## Nota para el cliente (cambio de números en Ventas por material)

> Desde hoy, en **Reportes → Ventas por material**, el **peso teórico** se calcula con los datos
> reales de cada bobina que se usó (su ancho y su espesor), y ya no con las medidas nominales del
> producto. Tampoco suma el 1 % de merma estándar. Por eso el peso teórico y el **rendimiento**
> (teórico − real) de cada fila cambian, también en los meses anteriores y en la rentabilidad de
> cada comprobante. La venta, el peso real y el costo **no cambian**. Al hacer clic en una fila
> ahora se ven las bobinas que se usaron y, en cada una, los comprobantes que se las llevaron.
