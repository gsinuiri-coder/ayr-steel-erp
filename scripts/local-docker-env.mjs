// Constantes del Postgres local (docker-compose.yml): un solo lugar para que
// scripts/dev-local.mjs, scripts/db-local.mjs, playwright.config.ts y e2e/global-setup.ts no
// diverjan. Si cambian acá, cambian también en docker-compose.yml (están duplicadas ahí a
// propósito, YAML no puede importar JS).
//
// No son secretos reales: la base es 100% local, descartable, y nunca sale de localhost
// (docs/ENTORNOS.md). Por eso van fijas en vez de generadas al azar como .env.demo (D-125):
// acá no hay ningún dato ajeno que proteger.
export const DB_HOST = '127.0.0.1';
// 5433 ya lo usa otro proyecto local; 5434 evita el choque (ver docker-compose.yml).
export const DB_PORT = 5434;
export const DB_USER = 'ayr';
export const DB_PASSWORD = 'ayr_local';

// Dos bases en el mismo contenedor (ver docker/postgres-init): "dev" es la que usa
// `pnpm dev:local` día a día; "e2e" es la que la suite Playwright vacía en cada corrida.
export const DB_NAME_DEV = 'ayr_local';
export const DB_NAME_E2E = 'ayr_local_e2e';

// Base del Postgres de **servicio del runner** de GitHub Actions (`.github/workflows/ci.yml`,
// job `e2e`, D-202). No es una base de esta máquina: vive acá porque `localTestDbUrls` tiene que
// reconocerla para no pisarla con la de Docker cuando la suite corre en CI.
export const DB_NAME_CI_E2E = 'ayr_ci_e2e';

export function dbUrl(name) {
  return `postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${name}?schema=public`;
}

/**
 * Base de pruebas de una rama `local`/`local-e2e`, **respetando la que ya venga en el entorno**
 * cuando es una base de pruebas legítima.
 *
 * Existe por el defecto que dejó los 6 specs del importador en rojo en CI (auditoría post-V4):
 * un script que arma la URL con `dbUrl(...)` sin mirar el entorno siempre apunta al Docker de
 * la máquina del agente, y desde D-202 la suite de CI corre contra el Postgres **del runner**
 * (`localhost:5432/ayr_ci_e2e`). El CLI se conectaba a una base que en el runner no existe y su
 * guarda de esquema lo reportaba como «falta la migración de D-206», que es verdad de esa base
 * y mentira del asunto.
 *
 * `??=` no alcanza acá: el wrapper compone el entorno del hijo, así que la decisión es *qué
 * poner*, no *qué completar*.
 *
 * **Falla hacia el Docker local, nunca hacia afuera.** Una URL heredada solo gana si es una de
 * las dos bases de pruebas reconocidas —misma forma que la lista blanca de
 * `apps/api/prisma/test-db-guard.ts`, menos la rama Neon `ci`, que no es una rama «local»—; con
 * cualquier otra cosa en `DATABASE_URL` (Neon `dev` exportado a mano para otra cosa, o peor)
 * se ignora el entero y se usa la de Docker. Las dos URLs se deciden juntas y se validan las
 * dos: `migrate`/lectura de esquema van por `DIRECT_URL` y la escritura por `DATABASE_URL`, y
 * aprobar mirando una sola fue exactamente el agujero que documenta ese guard.
 */
export function localTestDbUrls(branch) {
  const expected = { local: DB_NAME_DEV, 'local-e2e': DB_NAME_E2E }[branch];
  if (!expected) return null;

  const fromEnv = [process.env.DATABASE_URL, process.env.DIRECT_URL];
  if (fromEnv.every((u) => u && isKnownTestDb(u, expected))) {
    return { databaseUrl: fromEnv[0], directUrl: fromEnv[1], source: 'entorno' };
  }
  return { databaseUrl: dbUrl(expected), directUrl: dbUrl(expected), source: 'docker' };
}

function isKnownTestDb(raw, expected) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const name = url.pathname.replace(/^\//, '');
  const isLocalHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  // El Postgres de docker-compose.yml, con la base que la rama pedida nombra: `--branch local`
  // no puede terminar escribiendo en `ayr_local_e2e` ni al revés.
  if (isLocalHost && name === expected) return true;
  // El Postgres de servicio del job `e2e` (D-202). `GITHUB_ACTIONS=true` es parte de la
  // condición: un `localhost/ayr_ci_e2e` en la máquina de alguien no es esta base aunque se
  // llame igual (mismo criterio y misma razón que `test-db-guard.ts`).
  return (
    process.env.GITHUB_ACTIONS === 'true' && url.hostname === 'localhost' && name === DB_NAME_CI_E2E
  );
}

export const LOCAL_JWT_SECRET =
  'ayr-local-docker-secreto-de-desarrollo-nunca-usar-fuera-de-localhost';
export const LOCAL_ADMIN_EMAIL = 'admin@ayr.local';
export const LOCAL_ADMIN_PASSWORD = 'AyrLocal-2026!';

// Segundo usuario, exclusivo de `pnpm dev:preview` (apps/api/prisma/seed-view.ts): admin@ayr.local
// vive en la misma base que "pnpm dev:local" y su contraseña puede haber cambiado — cualquiera con
// sesión abierta ahí puede haber pasado por el flujo de cambio obligatorio (RF-03), lo que deja a
// LOCAL_ADMIN_PASSWORD desactualizada sin que nada lo avise. Este usuario es solo para mirar la app
// en :4001 y su contraseña se reafirma en cada arranque, así el login nunca depende de lo que haga
// el otro proceso sobre la misma fila.
export const LOCAL_VIEWER_EMAIL = 'viewer@ayr.local';
export const LOCAL_VIEWER_PASSWORD = 'AyrLocalView-2026!';
