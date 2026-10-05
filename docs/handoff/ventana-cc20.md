# Ventana cc20 — D-388: casilla para superar la tolerancia del 1 % en el reporte

## Ejecutada el 2026-10-05: sin incidencias

Cada paso sensible tuvo el OK explícito del dueño (D-251/D-232).

| Qué                            | Resultado                                                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| UAT                            | Confirmado por el dueño en demo: caso real a medida (OP-000033, 1,62 %) y planchas (OP-000034, 1,97 %)                                          |
| CI del PR #100                 | Corrida 37258995892 sobre `9d70d02`: unitarios 2542, E2E 512, smoke de Neon `ci` 36, Sonar en verde (antes, 56 % de cobertura nueva; corregido) |
| Condiciones                    | Sin migración; PR `CLEAN` sobre `main` `cfc72af`; nadie operando                                                                                |
| Revisión API anterior (vuelta) | `ayr-steel-erp-api-00084-6vs`, `git-sha=dc45734`                                                                                                |
| Paso 1: deploy de la API       | **`ayr-steel-erp-api-00085-np4`**, al 100 %, `git-sha=9d70d02`, `/health` 200, `smoke:prod` 8/8 con la web vieja                                |
| Paso 2: merge del #100         | `main` = **`e6c8dab`**, diff de runtime vacío, Vercel `success` (`…-6mz4tf5uy-…`), `smoke:prod` 8/8 en `vercel.app` y en `v2.mareliac.pe`       |
| Datos                          | Ninguno en producción. El caso real lo reporta el cliente                                                                                       |
| Neon                           | 9 ramas de 10; no se creó ninguna                                                                                                               |

**Vuelta atrás desde el merge.** Las dos juntas, con OK del dueño:

```sh
cmd /c gcloud run services update-traffic ayr-steel-erp-api --region us-central1 --project ayr-steel-erp --to-revisions ayr-steel-erp-api-00084-6vs=100
vercel rollback https://ayr-steel-erp-gfh4iysi3-gsinuiricoders-projects.vercel.app --scope gsinuiricoders-projects --yes
```

El segundo vuelve al despliegue de producción de `cfc72af`.

## Resumen

Sesión cc20, PR #100 (rama `cc20/tolerancia-reporte`, desde `main` `cfc72af`). La pieza es
urgente: la producción del cliente está detenida esperando el caso real.

Implementación completa. Las dos revisiones no dejaron P0, y sus P1 y P2 están corregidos o
aceptados por decisión del dueño. **Sin migración.** Toca la API y la web.

## Hecho

- **`@ayr/shared`:**
  - `packages/shared/src/schemas/production.ts`: `THEORETICAL_KG_OVERRIDE_MAX_RATIO`, los códigos
    `TOLERANCE_OVERRIDE_REQUIRED` y `TOLERANCE_EXCEEDED`, y `mountedKgForReport` con
    `overrideBands`;
  - `roofing.ts`: los motivos, `toleranceOverrideSchema`, los campos del reporte, del commit y de
    la fila del borrador;
  - `productionReportSchema.toleranceOverride`.
- **API:**
  - `roofing-production.service.ts` (`reportInTx`): el rol, la franja, el código con las cifras y
    la auditoría propia;
  - `roofing-drafts.ts` y `roofing-drafts.service.ts`: la marca `outOfTolerance` y la casilla por
    fila en `commit`;
  - `production.service.ts` (`findOne`): la etiqueta, leída de la auditoría;
  - `production-shared.ts`: la acción de la auditoría y su esquema.
- **Web:**
  - `planta/roofing-order-panel.tsx` y `planta/tolerance-override.tsx`: el editor, la marca, la
    casilla y el motivo, y los botones;
  - `produccion/[id]/produccion-detalle-view.tsx`: la etiqueta «Fuera de tolerancia».
- **Tests:**
  - `apps/api/src/production/tolerance-override-d388.spec.ts`;
  - `e2e/tests/tolerancia-reporte-d388.spec.ts`.

## Decisiones tomadas

D-388 en `docs/ARQUITECTURA.md` §0.2. Decisiones del dueño en la Fase 0 y en las revisiones:

- la dirección hacia abajo y el despunte no cambian;
- la terminación sigue siendo por el cierre;
- solo coberturas, sin drywall ni el accesorio;
- se autoriza al ejecutar el borrador, sin migración.

## Bloqueos / pendientes

- **Riesgo aceptado:** la franja se mide **por reporte**. Una bobina vaciada en dos filas puede
  pasar el 5 % en la última. El caso real va en una fila.
- Los P2 y P3 anotados están en `docs/PROGRESO.md`, entrada cc20.
- Fuera de alcance: el sobrante de bobina usado en otra producción.

## Cómo verificar

- Unitarios, desde `apps/api`: `npx jest src/production/tolerance-override-d388.spec.ts`.
- E2E: `pnpm exec playwright test e2e/tests/tolerancia-reporte-d388.spec.ts`, con la base propia
  `ayr_local_e2e_cc20`.
- Pantalla: el guion `docs/uat/cc20.md`.

## Siguiente sesión

Ninguna autorizada. Los pendientes de D-388 se toman solo si el dueño los asigna.

---

## Convivencia entre versiones

- **API nueva + web vieja (entre el deploy y Vercel):**
  - la web vieja ignora los campos nuevos (`outOfTolerance`, `toleranceOverride`);
  - su editor sigue aplicando el 1 % localmente, así que no carga filas de la franja;
  - un borrador ya cargado en la franja (no puede existir antes del deploy) recibiría el 400 con
    código.
- **Web nueva + API vieja:** la API vieja rechaza la fila al agregarla, como hoy, y descarta el
  campo desconocido del commit.
- **Orden:** API → merge, enseguida.

## Runbook

Cada paso marcado **[OK]** espera el OK explícito del dueño (D-251/D-232).

### 0. UAT en demo [dueño]

Demo desde `../ayr-cc20` en 3100/3101, sobre el último commit de la rama. Guion: `docs/uat/cc20.md`.

### 1. Antes de empezar [agente]

```sh
git fetch
gh pr checks 100
git rev-parse origin/cc20/tolerancia-reporte     # = <SHA>
git diff --name-only origin/main origin/cc20/tolerancia-reporte -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
```

**Vuelta atrás de la API: `ayr-steel-erp-api-00084-6vs`** (`git-sha=dc45734`, D-387), hoy al
100 %.

### 2. Resumen D-232 y OK [OK]

### 3. Deploy de la API [OK]

```sh
AYR_ENV_SETUP=C:/Users/User/Documents/workspace/ayr/ayr-steel-erp/.env.setup pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
```

Desde `../ayr-cc20`, limpio en `<SHA>`. Verificar:

- el `git-sha`;
- la revisión al 100 %;
- `/health` 200;
- `pnpm smoke:prod`, con la salida a `local-data/cc20/`.

### 4. Merge del #100: publica la web [OK]

```sh
gh pr ready 100
AYR_OWNER_PUSH=1 gh pr merge 100 --merge
```

Después:

- diff de runtime vacío contra `<SHA>`;
- Vercel en `success`;
- `smoke:prod` en `vercel.app` y en `v2.mareliac.pe`.

### 5. Vuelta atrás después del merge (las dos juntas, con OK)

```sh
cmd /c gcloud run services update-traffic ayr-steel-erp-api --region us-central1 --project ayr-steel-erp --to-revisions ayr-steel-erp-api-00084-6vs=100
vercel rollback <despliegue de producción de main anterior> --scope gsinuiricoders-projects --yes
```

El despliegue de producción del `main` anterior sale de GitHub Deployments de ese SHA.

**Datos:** un reporte autorizado se deshace con lo de siempre: reabrir la orden y revertir el
reporte.
