# Runbook — deploy de cc07 (D-373, reactivar comprobante anulado) y reactivación de BBV1-00000341

**Estado: PREPARADO, sin ejecutar.** Cada paso marcado **[OK]** espera el OK explícito del dueño en
la sesión (D-251/D-232). El agente propone el comando exacto y espera; no encadena comandos de
producción.

- PR: rama `cc07/reactivar-comprobante` (enlace en `docs/PROGRESO.md`).
- **Sin migración.** No hay `db:prod`, `migrate diff` ni `migrate deploy`. El respaldo Neon
  pre-ventana es opcional y lo decide el dueño por nombre (no hay escritura masiva; la única
  escritura de datos la hace el dueño por la interfaz). Nombre sugerido: `respaldo-pre-cc07-<fecha>`.
- **Orden obligatorio: API → web.** La web nueva con la API vieja muestra «Reactivar» y el modal,
  pero el `POST /reactivate` daría 404. Al revés no rompe nada: la web vieja no conoce la ruta
  nueva. El merge a `main` va **después** del deploy de la API (un push a `main` publica la web).
- `deploy:api` exige `--web-origin` (faltaba en el runbook de cc06).

## 0. Requisitos previos — los hace el dueño por la interfaz, antes de la ventana

1. **Confirmar en Nubefact/SUNAT que `BBV1-00000341` sigue vigente** (que nunca se comunicó su
   baja). Es lo que la casilla del modal afirma; el ERP no lo puede saber de un manual.
2. **Eliminar el borrador del reingreso de PED-000048.** Es la BOLETA en borrador, sin número,
   creada el 2026-10-01 a las 01:20 (Lima). Comprobantes → buscar `PED-000048` → fila «Borrador» →
   detalle → **Descartar borrador**, con motivo (p. ej. «Reingreso de BBV1-00000341: se reactiva
   el original»). Mientras exista, la reactivación se rechaza con «Hay 1 borrador(es) de
   comprobante sobre las mismas líneas del pedido PED-000048: elimínalo(s) primero…».

## 1. Antes de empezar [agente]

Desde el checkout principal (`ayr-steel-erp`), el único con `.env.setup`:

```sh
git fetch
gh pr checks <PR>                                # todo verde, Sonar incluido
git rev-parse origin/cc07/reactivar-comprobante  # = <SHA>
git log --oneline origin/main..origin/cc07/reactivar-comprobante
git diff --name-only origin/main origin/cc07/reactivar-comprobante -- apps/api/prisma
                                                 # vacío: si aparece algo, se para
```

- Si `main` avanzó, se actualiza la rama, se espera la CI nueva y se vuelve a empezar.
- Anotar la revisión vigente de la API para volver atrás:

```sh
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

## 2. Deploy de la API [OK]

```sh
git checkout --detach <SHA>                      # el script etiqueta con el HEAD
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Verificar: `git-sha` = `<SHA>` corto, revisión nueva con 100 % del tráfico, `/health` 200, y
`pnpm smoke:prod` verde desde un worktree en `<SHA>` (con `AYR_ENV_SETUP` apuntando al
`.env.setup` del checkout principal). Nunca `e2e:prod` (D-126). Si algo falla: vuelta atrás de la
API y parar.

## 3. Merge a `main`, publica la web [OK]

Resumen D-232: commits del PR, sin migración, D-373, autorrevisión y segundo modelo con P0/P1
corregidos, CI verde con la suite E2E completa, revisión del dueño.

```sh
AYR_OWNER_PUSH=1 gh pr merge <PR> --merge
git fetch
git diff --quiet <SHA> origin/main -- apps packages Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml
                                                 # exit 0
```

Esperar el deploy de Vercel y correr `pnpm smoke:prod --base-url https://v2.mareliac.pe`.

## 4. Reactivar BBV1-00000341 y despacharlo — el dueño, por la interfaz

1. **Comprobantes** → chip **Anulados** → buscar `BBV1-00000341`.
2. En su fila, **⋯ → Reactivar**. El modal muestra la anulación (fecha, autor, motivo «mal
   despacho»). Escribir el motivo (p. ej. «Anulado por error el 2026-10-01; el comprobante sigue
   vigente») y marcar **«Confirmo que este comprobante sigue vigente en Nubefact/SUNAT (no se
   comunicó su baja)»** → **Reactivar**.
   - Si sale un bloqueo, **no seguir**: el mensaje dice cuál (borrador, cobro, nota de crédito,
     líneas refacturadas, rastro de PSE). Avisar al agente.
3. La pantalla pasa al detalle de 341 con el aviso **«Comprobante reactivado: queda pendiente de
   despacho»** y la fecha de despacho en **03/08/2026** (la del comprobante).
4. **Antes de pulsar**, leer la lista de líneas del aviso:
   - Línea 1 `UPVC36MT` 12 debería decir «Sale del almacén».
   - Línea 2 `AUTOPERF10X1` 100: en la foto del 2026-09-29 su salida al 2026-08-03 dejaba negativo
     el kardex (`BLOQUEADO-RECOSTEO`). Si dice «No se despacha — … negativo …», **esa línea no se
     despacha a esa fecha**. No elegir otra fecha sin decisión del dueño (regla: la salida va con
     la fecha del comprobante); se registra el caso y se decide aparte.
5. **Despachar en la fecha seleccionada.** Despacha las líneas que salen; las de revisión quedan
   pendientes.
6. Verificar:
   - el detalle de 341 dice **Aceptado** y su saldo volvió a cuentas por cobrar;
   - el despacho nuevo tiene fecha 03/08/2026 y el kardex de `UPVC36MT` muestra la salida de 12 con
     esa fecha;
   - **Auditoría** de 341: `create`, `register-manual`, `dispatch-at-issue-date`, `annul` y
     **«Comprobante importado/manual reactivado (anulado por error)»**, con la copia de la anulación
     en «antes».

## 5. Después de la ventana [agente]

- Registrar tiempos y resultados medidos en `docs/PROGRESO.md` y marcar D-373 como desplegada.
- Cerrar el worktree `../ayr-cc07` (copiar antes su `local-data/` si tiene algo, AGENTS §4).

## Vuelta atrás

- **Código, solo API** (web sin publicar): volver el tráfico a la revisión anotada en el paso 1.
  **[OK]**

```sh
cmd /c gcloud run services update-traffic ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --to-revisions <revisión anterior>=100
```

- **Código, con la web publicada:** PR de revert en `main` y después volver la API.
- **Datos, la reactivación de 341** (si resultó equivocada): el administrador lo **anula otra vez**
  desde su detalle, con **Anular internamente** (la anulación interna sigue igual). Si ya se despachó, primero se **revierte el
  despacho** desde su pantalla (movimiento inverso en el kardex, regla dura 8) y después se anula.
  La auditoría conserva las tres operaciones; no hay nada que borrar.
