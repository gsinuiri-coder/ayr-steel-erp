# Ventana cc19 — D-387: comprobante en cotizaciones y formulario de fecha de despacho

## Ejecutada el 2026-10-04: sin incidencias

Cada paso sensible tuvo el OK explícito del dueño (D-251/D-232).

| Qué                                              | Resultado                                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UAT                                              | Confirmado por el dueño en demo, sobre `0608782`, con los estados de la columna                                                                                                                         |
| Reacomodo                                        | Sobre `main` `523c198` (D-386 de cc18 y su PR de docs #98); conflictos solo de docs                                                                                                                     |
| CI del PR #97                                    | Corrida 37235144319 sobre `dc45734`: unitarios 2497, kardex contra la base 31, E2E 509 pasados y 3 saltados, smoke de Neon `ci` 36 pasados y 2 saltados, Sonar en verde                                 |
| Condiciones del dueño                            | `dc45734` contiene `43d2bd4`; sin migración; la API nueva es compatible con la web de `523c198`; nadie operando                                                                                         |
| Revisión API anterior (vuelta)                   | `ayr-steel-erp-api-00083-q96`, `git-sha=43d2bd4`                                                                                                                                                        |
| Paso 1: deploy de la API                         | **`ayr-steel-erp-api-00084-6vs`**, al 100 %, `git-sha=dc45734`, `/health` 200, `smoke:prod` 8/8 con la web vieja (`local-data/cc19/smoke-prod-api-dc45734.txt`)                                         |
| Paso 2: merge del #97                            | `main` = **`35073be`**, diff de runtime vacío contra `dc45734`, Vercel `success` (`…-1szifzgjo-…`), `smoke:prod` 8/8 en `vercel.app` y 8/8 en `v2.mareliac.pe` (`local-data/cc19/smoke-prod-web-*.txt`) |
| Conteo en producción (por la API, admin efímero) | 145 no anuladas: 48 registrado, 97 solo referencia, 0 no coincide, 0 sin nada; ninguna con varios comprobantes (`local-data/cc19/conteo-estados-produccion.txt`)                                        |
| Datos                                            | Ninguno                                                                                                                                                                                                 |

**Vuelta atrás desde el merge.** La API vieja con la web nueva rompe la lista de cotizaciones, así
que se vuelven **las dos juntas**, con OK del dueño:

```sh
cmd /c gcloud run services update-traffic ayr-steel-erp-api --region us-central1 --project ayr-steel-erp --to-revisions ayr-steel-erp-api-00083-q96=100
vercel rollback https://ayr-steel-erp-nri2k5atw-gsinuiricoders-projects.vercel.app --scope gsinuiricoders-projects --yes
```

El segundo comando apunta al despliegue de producción de `523c198`. Después de un rollback, Vercel
no asigna el dominio a los despliegues nuevos hasta que se vuelva a promover uno.

**E2E locales de cc19:** no valen como evidencia. Antes de que cada sesión usara su propia base, las
corridas de cc18 pudieron vaciar `ayr_local_e2e` mientras corrían las de cc19. El veredicto es la
CI.

## Resumen

Sesión cc19, PR #97. Están completos los milestones M1, M2 y M3, y el ajuste de estados. Cada tanda
tuvo sus dos revisiones, sin P0 ni P1. Está desplegada (ver arriba).

## Hecho

- **M1:** el formulario de fecha de despacho del detalle del comprobante ya no se desmonta.
  - Archivo: `apps/web/src/app/(app)/comprobantes/[id]/dispatch-at-issue-date.tsx`.
  - E2E: caso D-387 en `e2e/tests/despacho-fecha-comprobante-d278.spec.ts`, rojo sin el arreglo.
- **M2:** columna «Comprobante» en `/cotizaciones`, con buscador y orden.
  - `packages/shared/src/schemas/quotation-import.ts`: `importedInvoiceNumber`,
    `compareImportedInvoiceNumbers`, `normalizeInvoiceNumber`, `quotationInvoiceState`,
    `shownInvoiceNumber` e `invoiceNumberContains`.
  - `apps/api/src/common/list-orderings.ts`: `orderByInvoiceNumber`.
  - `apps/api/src/sales/quotations.service.ts`: `liveInvoiceDocuments`, `findAll`,
    `idsByInvoiceNumber` y `findPageByImportedInvoice`.
  - `apps/web/src/components/sales/quotation-invoice.tsx`, usado en `cotizaciones-view.tsx`.
- **Ajuste del dueño, D-387 (D):** cuatro estados de la columna (solo referencia, registrado, no
  coincide, vacío), calculados al leer.
- **M3:** el mismo estado en la cabecera de `cotizacion-detalle-view.tsx`.
- **Extra con OK del dueño:** `apps/api/src/common/search-seq.ts`. Un RUC ya no da 500 en los
  buscadores de cotizaciones y pedidos.

## Decisiones tomadas

- **D-387:**
  - leer el comprobante al vuelo, sin migración (decisión del dueño);
  - arreglar el 500 del RUC en las dos listas (decisión del dueño);
  - la columna distingue la referencia del Excel del comprobante registrado (ajuste del dueño);
  - la tarjeta de despacho la decide el plan sin fecha.

## Bloqueos / pendientes

- Los P2 y P3 de las revisiones están anotados en `docs/PROGRESO.md`, entrada cc19. El más visible:
  el buscador compara los dígitos del texto contra el número de cotización, y cambiarlo necesita
  decisión del dueño.
- Ningún bloqueo técnico.

## Cómo verificar

- Unitarios, desde `apps/api`: `npx jest src/sales/imported-invoice-d387.spec.ts src/common/search-seq.spec.ts src/common/list-orderings.spec.ts`.
- E2E: `pnpm exec playwright test e2e/tests/comprobante-en-cotizaciones-d387.spec.ts e2e/tests/despacho-fecha-comprobante-d278.spec.ts`.
- Pantalla: guion `docs/uat/cc19.md`.

## Siguiente sesión

Ninguna autorizada por esta sesión. Los pendientes de D-387 son P2/P3 de `docs/PROGRESO.md`:

- el buscador compara los dígitos contra el número de cotización;
- el orden por comprobante tiene su gatillo de 1.000 cotizaciones.

Se toman solo si el dueño los asigna.

## Estado al cierre de la implementación

- PR: #97 (rama `cc19/comprobante-en-cotizaciones`, desde `main` `9d88277`).
- Decisión: D-387 en `docs/ARQUITECTURA.md` §0.2. Guion UAT: `docs/uat/cc19.md`.
- Revisiones: `docs/revision/cc19-autorrevision.md` y `docs/revision/cc19-segundo-modelo.md`.
- **Sin migración.** El deploy no escribe datos. **Toca la API y la web.**
- Sesión en paralelo: cc18 (D-386, solo API). **Entró primero:** API `00083-q96` con
  `git-sha=43d2bd4`; `main` quedó en `523c198` tras el PR #98 de docs. Esta rama se reacomodó sobre
  `523c198`. Los conflictos fueron solo de docs: §0.2 y `docs/PROGRESO.md`, donde quedaron las dos
  entradas. El código combinó limpio, incluido `sales-orders.service.ts`, que tocan las dos ramas.

### Qué cambia

- **Web:**
  - formulario «Fecha de despacho» del detalle del comprobante (`dispatch-at-issue-date.tsx`);
  - columna «Comprobante» en `/cotizaciones`, con orden y buscador;
  - «Comprobante» en la cabecera del detalle de la cotización.
- **API:**
  - `externalInvoice` e `invoiceDocuments` (los comprobantes vigentes del pedido vivo) en el DTO de
    cotización, en lista y detalle;
  - `sort=invoice` en `GET /sales/quotations`, por el número mostrado;
  - el buscador de cotizaciones encuentra por comprobante: la marca y el registrado;
  - `searchSeqOf` en cotizaciones y pedidos: un RUC ya no da 500.
- **`@ayr/shared`:** `importedInvoiceNumber`, `normalizeInvoiceNumber`, `quotationInvoiceState` y
  compañía; `QUOTATION_SORT_KEYS` con `invoice`; los dos campos en `quotationSchema`.

### Convivencia entre versiones

- **API nueva + web vieja:** sin efecto visible. Los campos extra del DTO se ignoran y la web vieja
  no manda `sort=invoice`. El arreglo del RUC aplica de inmediato.
- **Web nueva + API vieja:** **la lista y el detalle de cotizaciones fallan.** La API vieja no
  manda `invoiceDocuments`, y el componente lo lee.
- Por eso: **API primero y merge enseguida, nunca al revés.**

## Runbook

Cada paso marcado **[OK]** espera el OK explícito del dueño (D-251/D-232): el agente propone el
comando exacto y espera.

**Orden:** UAT en demo → reacomodar y CI → D-232 → API → smoke → merge (web) → smoke.

### 0. UAT en demo [dueño]

Con la CI en verde, se le pregunta al dueño si demo está libre (lo comparte con cc18).

```sh
AYR_ENV_SETUP=<principal>/.env.setup pnpm env:demo
AYR_ENV_SETUP=<principal>/.env.setup pnpm db:demo
pnpm dev:demo
```

Va desde `../ayr-cc19`, en 3100/3101. `db:demo` solo aplica migraciones (no hay nuevas), purga
sesiones y siembra el admin de demo. Antes de avisar, verificar el commit que corre. Guion:
`docs/uat/cc19.md`.

### 1. Reacomodar sobre `main` y CI [agente]

```sh
git fetch
git -C ../ayr-cc19 rebase origin/main
git -C ../ayr-cc19 push --force-with-lease
gh pr checks 97 --watch
```

### 2. Antes de empezar [agente]

```sh
gh pr checks 97
git rev-parse origin/cc19/comprobante-en-cotizaciones     # = <SHA>
git diff --name-only origin/main origin/cc19/comprobante-en-cotizaciones -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
```

La revisión vigente de Cloud Run, su `git-sha` y su tráfico se leen con un `.mjs` en el
scratchpad que use `scripts/lib.mjs#run`. Esa revisión es la vuelta atrás y se anota acá:
**`ayr-steel-erp-api-00083-q96`, `git-sha=43d2bd4` (la de cc18), al 100 %**. El commit a desplegar
tiene que contener `43d2bd4` (`git merge-base --is-ancestor 43d2bd4 <SHA>`): si no, el deploy le
quitaría D-386 a producción.

**Sin foto de producción:** no hay datos que verificar. El conteo de la marca se hizo en demo y está
en D-387.

### 3. Resumen de D-232 y OK del dueño [OK]

Incluye:

- los commits y la CI de la última corrida;
- qué se despliega: API y web, sin migración;
- el riesgo: el orden por comprobante lee todas las filas del filtro (hoy, 80 cotizaciones), y el
  formulario de despacho cambia su lógica de carga;
- las dos revisiones.

### 4. Deploy de la API [OK]

```sh
git checkout --detach <SHA>
pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
git checkout main
```

Desde un worktree, `AYR_ENV_SETUP` apunta al `.env.setup` del checkout principal. Verificar:

- el `git-sha`;
- la revisión al 100 %;
- `/health` 200.

Después, `pnpm smoke:prod` desde un worktree en `<SHA>`, con la salida completa a un archivo en
`local-data/cc19/`.

### 5. Merge a `main`: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge 97 --merge
```

Verificar:

- el diff de runtime contra `<SHA>`, vacío;
- Vercel `success`;
- `smoke:prod` contra `vercel.app` y contra `--base-url https://v2.mareliac.pe`.

### 6. Verificación en producción [dueño]

1. En `/cotizaciones`, la columna «Comprobante» muestra los `FFA1-…` y `BBV1-…`.
2. Ordenar por la columna.
3. Buscar un RUC.

No escribe nada.

## Vuelta atrás

- **Con la web vieja:** volver el tráfico a la revisión anotada en el paso 2.
- **Con la web publicada:** PR de revert y merge; después, desplegar la API.
- **Datos:** no hay.
