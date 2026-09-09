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

export function dbUrl(name) {
  return `postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${name}?schema=public`;
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
