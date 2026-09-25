# Runbook — deploy del color comercial (D-270..D-274)

**Estado: EJECUTADO** el 2026-09-24 → 25 (pasos 0 a 5c, y después D-285). Resultado en `docs/PROGRESO.md`, «Ventana de correcciones 02». Cada paso marcado
**[OK]** espera el OK explícito del dueño en la sesión (D-251/D-232).

- PR: https://github.com/gsinuiri-coder/ayr-steel-erp/pull/18, rama `feat/color-comercial`.
- Después del retiro de NATURAL (paso 5), y solo si su CI está verde: la PR #19 de
  `fix/deudas-post-s4b` (paso 5b), con deploy de API solo si cambia el runtime.
- **Sin migración.** No hay `db:prod`, ni `migrate diff`, ni respaldo por migración.
- API vigente para volver atrás: revisión `ayr-steel-erp-api-00045-plw`, `git-sha=cdebf9c`.

**Orden obligatorio: API → web.** La web nueva con la API vieja rompe `/reportes/inventario-valorizado`
(el grupo no trae `finishes`). Al revés no rompe nada: la web vieja ignora los campos nuevos.
Por eso **el merge a `main` va después del deploy de la API**, no antes: un push a `main`
publica la web en Vercel.

Tiempos de referencia (RF-S4b, no medidos para este cambio): deploy de API ≈ 4–5 min, Vercel
≈ 2–3 min, smoke ≈ 1 min. Total estimado: 20–30 min con las esperas de OK.

## 0. Antes de empezar [agente]

Desde el checkout principal (`ayr-steel-erp`), que es el único con `.env.setup`:

```sh
git fetch
gh pr checks 18                       # todo verde, Sonar incluido
git rev-parse origin/feat/color-comercial   # = <SHA>, el que se despliega
git log --oneline origin/main..origin/feat/color-comercial   # main no se movió debajo
git diff --name-only origin/main origin/feat/color-comercial -- apps/api/prisma/migrations apps/api/prisma/schema.prisma
                                      # vacío: si aparece algo, se para
node scripts/migrations-status.mjs --branch production   # sin pendientes
```

Si `main` avanzó, se rebasa la rama, se espera la CI nueva y se vuelve a empezar.

## 1. Deploy de la API [OK]

```sh
git checkout --detach <SHA>           # el script etiqueta con el HEAD
pnpm deploy:api
git checkout main
```

## 2. Verificar la API [agente]

```sh
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

- `git-sha` = `<SHA>` corto, revisión nueva con 100 % del tráfico.
- `GET <url del deploy>/health` → 200.
- `pnpm smoke:prod` desde un worktree en `<SHA>`: verde con **web vieja + API nueva**.

**Si algo falla acá:** volver atrás (§Vuelta atrás) y parar. Nada se tocó en datos.

## 3. Merge a `main`, publica la web [OK]

Resumen D-232: los commits de la PR #18, sin migración, D-270..D-274, autorrevisión sin P0/P1, CI verde.

```sh
gh pr merge 18 --merge                # merge commit, no squash: el árbol de main queda = <SHA>
git fetch
git diff --quiet <SHA> origin/main -- apps packages Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml
                                      # exit 0: la API desplegada coincide con main
```

Esperar el deploy de Vercel (`gh run list --branch main --limit 1` y el estado de Vercel).

## 4. Smoke de producción [agente]

```sh
pnpm smoke:prod                       # desde el worktree en <SHA>, solo lectura
```

Verificación a ojo, sin confirmar nada:

- `/reportes/inventario-valorizado`: ROJO con el detalle «RAL 3002 (ALZ-ROJO-3002)» y
  «RAL 3020 (ALZ-ROJO-3020)»; NATURAL como su propio grupo; **total de bobinas
  S/ 572 992.1133** (o lo que haya al momento; tiene que ser igual al de antes del deploy:
  anotarlo en el paso 0).
- `/planta`: en una OP ROJO, «Buscar y montar» muestra la columna «Acabado (RAL)».
- Catálogo → Colores: «Nuevo color» con código `ROJO-3020` da el aviso del candado.

## 5. Retiro del color NATURAL (D-274) [OK por cada comando]

Respaldo antes de borrar datos (regla dura 4). El retiro solo desactiva un color y borra dos
filas de `raw_material_specs` sin referencias, pero es una escritura en production:

```sh
# [OK] respaldo Neon por el patrón de docs/ENTORNOS.md (lib.mjs#run, quiet, --output json):
#      rama respaldo-pre-color-comercial-20260924, padre production; verificar ready.

# [OK] dry-run: tiene que decir 2 specs (0.30 y 0.40 mm) y 0 en todas las referencias.
pnpm retire:unused-color --code NATURAL --branch production --confirm-production

# [OK] solo si el dry-run dio 0 paradas:
pnpm retire:unused-color --code NATURAL --execute --branch production --confirm-production

# después: el diagnóstico ya no debe mostrar el color ni las specs fundidas.
pnpm check:color-comercial --branch production --confirm-production
```

Esperado después: `[2] Specs que se funden: ninguna`, color NATURAL fuera del grupo NATURAL,
«Sin condiciones de parada». La auditoría queda con dos `raw_material_specs.delete` y un
`colors.retire`.

## 5b. Deudas post-RF-S4b: `fix/deudas-post-s4b` (PR #19) — solo si su CI está verde

Va **después** del paso 5 y con la PR #18 ya en `main`. La rama se construyó encima de
`feat/color-comercial`, así que después del merge de #18 su PR muestra solo sus propios commits.
Sin migración. Contenido: D-275 (el rechazo de reserva no nombra la cotización de otro
vendedor), D-276 (el cambio de producto + precio con cambio de unidad deja registro), `smoke:prod`
acepta `v2.mareliac.pe`, puerto de E2E configurable y un timeout de test. Handoff:
`docs/handoff/deudas-post-s4b.md`.

### 5b.0 Condiciones [agente] — si alguna falla, se salta el 5b entero y la ventana cierra con #18

```sh
git fetch
gh pr checks 19            # todo verde, Sonar incluido; si algo no está verde, NO se sigue
git rev-parse origin/fix/deudas-post-s4b          # = <SHA_D>, el que se despliega
git merge-base --is-ancestor origin/feat/color-comercial origin/fix/deudas-post-s4b   # exit 0
git log --oneline origin/main..origin/fix/deudas-post-s4b   # solo los commits de la PR (#18 ya está en main)
git diff --name-only origin/main origin/fix/deudas-post-s4b -- apps/api/prisma/migrations apps/api/prisma/schema.prisma
                                      # vacío: si aparece algo, se para
```

Si `main` avanzó con algo que no sea el merge de #18, se rebasa la rama, se espera la CI nueva y
se vuelve a empezar el 5b.

**¿Cambia el runtime?** Se compara con lo que la API ya tiene desplegado (el `<SHA>` de #18):

```sh
git diff --quiet <SHA> <SHA_D> -- apps packages Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml
```

- **exit 1** (esperado: la rama toca `apps/api/src`): hay deploy de API, pasos 5b.1 y 5b.2.
- **exit 0**: no hay deploy; se salta directo a 5b.3.

### 5b.1 Deploy de la API [OK]

```sh
git checkout --detach <SHA_D>         # el script etiqueta con el HEAD
pnpm deploy:api
git checkout main
```

### 5b.2 Verificar la API [agente]

```sh
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

- `git-sha` = `<SHA_D>` corto, revisión nueva con 100 % del tráfico. Anotar el nombre de la
  revisión.
- `GET <url del deploy>/health` → 200.

**Si algo falla acá:** volver la API a la revisión del paso 1 (la de #18) y parar; la PR queda
sin mergear para otra ventana.

### 5b.3 Merge a `main` [OK]

Resumen D-232: los commits de la PR, sin migración, D-275 y D-276, autorrevisión sin P0/P1, CI
verde.

```sh
gh pr merge 19 --merge     # merge commit, no squash
git fetch
git diff --quiet <SHA_D> origin/main -- apps packages Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml
                                      # exit 0: la API desplegada coincide con main
```

La rama no toca `apps/web`: el deploy de Vercel que dispara el merge publica la misma web.
Esperar que termine igual (`gh run list --branch main --limit 1` y el estado de Vercel).

### 5b.4 Smoke de producción, al final [agente]

```sh
pnpm smoke:prod --base-url https://v2.mareliac.pe   # desde un worktree en <SHA_D>, solo lectura
```

Es el primer smoke contra el dominio propio (antes lo rechazaba el guard). Si da rojo por el
dominio y no por la app, repetir sin `--base-url` (contra `ayr-steel-erp-web.vercel.app`) y
anotarlo. Si 5b se saltó, el smoke final es el del paso 4.

## 5c. Correcciones 02: `fix/correcciones-02` (PR #20) — solo si su CI está verde

Va **después** del 5b, con #18 y #19 ya en `main`. La rama se apiló sobre `fix/deudas-post-s4b`,
así que después de los dos merges su PR muestra solo sus propios commits. **Sin migración**: la columna
`description` de M7 ya existía en las tres tablas de líneas (D-283). Handoff: `docs/handoff/correcciones-02.md`.

Contenido: D-277 (estado «Listo»), D-278 (despacho a la fecha del comprobante, botón y CLI),
D-279 (kardex PEPS SUNAT 13.1), D-280 (disponible por lote), D-281 (metro lineal teórico),
D-282..D-284 (modal de bobina, descripción por línea, formularios).

### 5c.0 Condiciones [agente] — si alguna falla, se salta el 5c entero

```sh
git fetch
gh pr checks 20            # todo verde, Sonar incluido
git rev-parse origin/fix/correcciones-02          # = <SHA_C>, el que se despliega
git merge-base --is-ancestor origin/fix/deudas-post-s4b origin/fix/correcciones-02   # exit 0
git log --oneline origin/main..origin/fix/correcciones-02   # solo los commits de la PR
git diff --name-only origin/main origin/fix/correcciones-02 -- apps/api/prisma/migrations apps/api/prisma/schema.prisma
                           # vacío: si aparece algo, se para
node scripts/migrations-status.mjs --branch production   # sin pendientes
```

### 5c.1 Respaldo Neon [OK]

No lo pide una migración (no hay) sino el arreglo de datos del 5c.4, que escribe en production.

Rama `respaldo-pre-correcciones-02-20260924`, padre `production`, por el patrón de
`docs/ENTORNOS.md` (`lib.mjs#run`, `quiet`, `--output json`); verificar `ready`.

### 5c.2 Deploy de la API [OK] y verificación [agente]

```sh
git checkout --detach <SHA_C>
pnpm deploy:api
git checkout main
cmd /c gcloud run services describe ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --format "value(metadata.labels.git-sha,status.latestReadyRevisionName,status.traffic[0].percent)"
```

`git-sha` = `<SHA_C>` corto, revisión nueva al 100 %, `/health` 200. **Si falla:** API a la
revisión del 5b y parar; la migración aditiva puede quedarse.

### 5c.3 Merge a `main` [OK] y smoke [agente]

```sh
gh pr merge 20 --merge
git fetch
git diff --quiet <SHA_C> origin/main -- apps packages Dockerfile .gcloudignore package.json pnpm-lock.yaml pnpm-workspace.yaml
pnpm smoke:prod --base-url https://v2.mareliac.pe   # desde un worktree en <SHA_C>
```

### 5c.4 Arreglo de datos [OK por cada comando]

**M1 no tiene arreglo de datos** (D-277): el estado persistido no está mal, faltaba mostrar
«Listo». Después del deploy, PED-000001..017 y 019..021 tienen que verse «Listo».

**M2** (D-278), desde un worktree en `<SHA_C>` con `AYR_ENV_SETUP` apuntando al `.env.setup`
del checkout principal:

```sh
# [OK] dry-run: tiene que dar los mismos números que el del día (local-data/corr02/
#      dispatch-at-issue-date-production-2026-09-24T20-35-34-751Z.json):
#      28 comprobantes, 6 salidas (S/ 84 676.4100), 23 en la excepción, 15 a revisión.
pnpm dispatch:at-issue-date --branch production --confirm-production

# [OK] solo si el dry-run coincide. --expect compara el plan entero, comprobante por
#      comprobante, antes de escribir la primera fila:
pnpm dispatch:at-issue-date --execute --expect <json del dry-run de la ventana> --branch production --confirm-production

# después: otro dry-run tiene que dar 0 salidas, 0 excepciones y los mismos 15 a revisión.
pnpm dispatch:at-issue-date --branch production --confirm-production
```

Si el dry-run de la ventana no coincide con el del día, **se para** y se reporta la diferencia.

### 5c.5 Foto comparada [agente]

`node scripts/snapshot-reports.mjs snapshot post-correcciones-02 …` y `compare` contra la foto
base del paso 0. Esperado, y nada más:

- **Inventario valorizado:** baja exactamente **S/ 84 676.41**, el costo de las 6 salidas (las
  6 bobinas IMPO-ALZ-ROJO-3020 de PED-000018 quedan en cero y cerradas).
- **Ventas y margen (agosto y año):** el costo de FFA1-00001321 sube exactamente
  **S/ 84 676.41** (el reporte toma el costo de las salidas `SALE` de los despachos,
  `sales-margin.service.ts`). Las ventas no cambian.
- Catálogo `BOB…`: sin cambios.

Cualquier otra diferencia: se para.

## 6. Cierre [agente]

- Borrar la rama remota `docs/diseno-color-comercial`: su contenido ya está en `main`.
  Verificar antes con `git log origin/main --oneline -- docs/diseno/color-comercial-produccion.md`.
- Borrar la rama remota `feat/color-comercial` la decide el dueño.
- Anotar en `docs/PROGRESO.md` la revisión desplegada, los totales antes y después y la salida
  del retiro; y del 5b, si corrió o por qué se saltó, la revisión y el smoke contra
  `v2.mareliac.pe`.

## Vuelta atrás

- **API (pasos 1–2):**
  `cmd /c gcloud run services update-traffic ayr-steel-erp-api --project ayr-steel-erp --region us-central1 --to-revisions ayr-steel-erp-api-00045-plw=100`.
  No hay migración que deshacer.
- **Web (paso 3):** revertir el merge en `main` (`git revert -m 1 <merge>` y push con
  `AYR_OWNER_PUSH=1` y OK), o promover en Vercel el deploy anterior. **Primero la web, después
  la API**: la web nueva no puede quedar sobre la API vieja.
- **Deudas (paso 5b):** API a la revisión del paso 1 (la de #18) con el mismo
  `update-traffic`; si ya se mergeó, revertir primero el merge en `main` (`git revert -m 1
<merge>`, push con `AYR_OWNER_PUSH=1` y OK). No hay migración ni datos que deshacer.
- **Retiro (paso 5):** no hace falta PITR. Es reversible por dominio: reactivar el color en
  Catálogo → Colores. Las specs se recrean solas al cotizar (D-134) y sus filas quedan enteras
  en el `before` de la auditoría. El respaldo del paso 5 cubre cualquier otro caso por PITR a la
  rama `respaldo-pre-color-comercial-20260924`.
- **Correcciones 02 (paso 5c):** API a la revisión del 5b con el mismo `update-traffic`; si ya
  se mergeó, revertir primero el merge en `main`. No hay migración. Los despachos del 5c.4 se
  deshacen por dominio, uno por uno (`POST /dispatches/:id/reverse`, ADMINISTRADOR, con motivo:
  devuelve el kardex, restaura la reserva y reabre la bobina que cerró, D-170); para todo lo
  demás, PITR a `respaldo-pre-correcciones-02-20260924`.
