# Ventana cc21 — D-389: pasar la tolerancia del 1 % avisa y no bloquea

## Resumen

Sesión cc21, en dos PR:

- **PR #102** (rama `cc21/tolerancia-aviso`, desde `main` `30a2e1b`): planchas y a medida.
- **PR #103** (accesorio): apilado sobre el #102 y ya mergeado dentro de él.

D-389 reemplaza dos cosas de D-388: el tope duro del 5 % y la regla de «solo administrador». **Sin
migración.** Toca la API y la web.

## Hecho

- **`@ayr/shared`:**
  - `mountedKgForReport`: pasado el 1 % no hay tope, y `excess.severe` marca lo que pasa el 5 %;
  - se retira `TOLERANCE_EXCEEDED`;
  - nueva lista `TOLERANCE_OVERRIDE_REASONS_OVER`.
- **API:**
  - `reportInTx`: sin validación de administrador; el motivo tiene que aplicar a la dirección
    (`assertToleranceReasonApplies`);
  - el accesorio entra con la casilla;
  - la auditoría registra `severe`.
- **Web:**
  - `planta/tolerance-override.tsx` (`ToleranceOverrideRow`): el texto fuerte, solo los motivos que
    aplican, sin administrador, y la casilla atada al exceso;
  - la tarjeta del accesorio con la casilla, atada a la huella del rechazo, con el código atendido
    antes que el despunte;
  - `ApiError.details`.
- **Tests:**
  - unitarios `tolerance-override-d388*.spec.ts` y `roofing-drafts.spec.ts`;
  - E2E `tolerancia-reporte-d388.spec.ts` y `tolerancia-accesorio-d389.spec.ts`.

## Decisiones tomadas

D-389 en `docs/ARQUITECTURA.md` §0.2. Decisiones del dueño:

- sin tope, con aviso fuerte pasado el 5 %;
- la casilla la marca quien reporta;
- motivos según la dirección del exceso;
- el accesorio entra;
- drywall y el despunte no cambian.

## Bloqueos / pendientes

- **Riesgo P1 de política, presentado al dueño:** sin tope, la casilla deja pasar el caso de
  D-249, una bobina equivocada casi vacía.
- Los P2 y P3 anotados están en `docs/PROGRESO.md`, entrada cc21.

## Cómo verificar

- Unitarios, desde `apps/api`: `npx jest src/production`.
- E2E: `pnpm exec playwright test e2e/tests/tolerancia-reporte-d388.spec.ts e2e/tests/tolerancia-accesorio-d389.spec.ts`,
  con una base propia `ayr_local_e2e_<sufijo>`.
- Pantalla: el guion `docs/uat/cc21.md`.

## Siguiente sesión

Ninguna autorizada.

---

## Convivencia entre versiones

- **API nueva + web vieja (entre el deploy y Vercel):**
  - el borrador ya no rechaza más del 5 %, pero el editor viejo sigue rechazando localmente;
  - la web vieja manda la casilla solo con administrador; la API nueva la acepta igual;
  - el accesorio en la web vieja recibe el 400 con código y lo muestra como error, sin casilla
    (antes también se rechazaba).
  - Sin daño de datos.
- **Web nueva + API vieja:**
  - un supervisor con la casilla recibe 403;
  - más del 5 % se rechaza;
  - el accesorio con la casilla recibe 400.
- **Orden:** API → merge, enseguida.

## Runbook

Cada paso marcado **[OK]** espera el OK explícito del dueño.

### 1. Antes de empezar [agente]

```sh
gh pr checks 102
git diff --name-only origin/main origin/cc21/tolerancia-aviso -- apps/api/prisma/migrations apps/api/prisma/schema.prisma   # vacío
```

**Vuelta atrás de la API: `ayr-steel-erp-api-00085-np4`** (`git-sha=9d70d02`, D-388).

### 2. Deploy de la API [OK]

```sh
AYR_ENV_SETUP=C:/Users/User/Documents/workspace/ayr/ayr-steel-erp/.env.setup pnpm deploy:api --web-origin https://v2.mareliac.pe,https://ayr-steel-erp-web.vercel.app
```

Desde `../ayr-cc21`, limpio en `<SHA>`. Verificar:

- el `git-sha`;
- la revisión al 100 %;
- `/health` 200;
- `smoke:prod`, con la salida a `local-data/cc21/`.

### 3. Merge del #102: publica la web [OK]

```sh
AYR_OWNER_PUSH=1 gh pr merge 102 --merge
```

Después:

- diff de runtime vacío;
- Vercel en `success`;
- `smoke:prod` en `vercel.app` y en `v2.mareliac.pe`.

### 4. Vuelta atrás después del merge (las dos juntas, con OK)

```sh
cmd /c gcloud run services update-traffic ayr-steel-erp-api --region us-central1 --project ayr-steel-erp --to-revisions ayr-steel-erp-api-00085-np4=100
vercel rollback https://ayr-steel-erp-lydsar4ow-gsinuiricoders-projects.vercel.app --scope gsinuiricoders-projects --yes
```

El segundo vuelve al despliegue de producción de `30a2e1b`.
