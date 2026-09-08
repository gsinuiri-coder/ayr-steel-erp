import { defineConfig, devices } from '@playwright/test';
import {
  DB_NAME_E2E,
  LOCAL_ADMIN_EMAIL,
  LOCAL_ADMIN_PASSWORD,
  LOCAL_JWT_SECRET,
  dbUrl,
} from './scripts/local-docker-env.mjs';

/**
 * E2E contra api (:3000) + web (:3001) locales y la DB que indique DATABASE_URL
 * (en CI: Neon rama `ci`, reseteada en global-setup). Con E2E_BASE_URL apunta a
 * una URL externa (producción) y no levanta servidores ni resetea nada.
 */
const externalBaseUrl = process.env.E2E_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://localhost:3001';
const isCI = !!process.env.CI;

// Local (no CI, sin E2E_BASE_URL): por defecto contra el Postgres de docker-compose.yml, base
// "ayr_local_e2e" — separada de la que usa `pnpm dev:local` para no pisar datos de prueba
// manual. `??=` deja que quien exporte DATABASE_URL a mano (p. ej. para probar contra otra
// cosa) siga ganando. Neon `dev` ya no interviene en el E2E local; Neon `ci` sigue siendo
// exclusivo de CI (docs/ENTORNOS.md).
if (!isCI && !externalBaseUrl) {
  process.env.DATABASE_URL ??= dbUrl(DB_NAME_E2E);
  process.env.DIRECT_URL ??= dbUrl(DB_NAME_E2E);
  process.env.JWT_SECRET ??= LOCAL_JWT_SECRET;
  process.env.ADMIN_EMAIL ??= LOCAL_ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD ??= LOCAL_ADMIN_PASSWORD;
  // La base "ayr_local_e2e" es descartable y de uso exclusivo de la suite (nunca la de
  // `pnpm dev:local`), así que vaciarla en cada corrida es seguro y evita estado colgado
  // entre corridas — antes esto exigía E2E_RESET_DB=1 a mano porque local corría contra
  // Neon `dev`, que sí tenía datos que no se querían perder.
  process.env.E2E_RESET_DB ??= '1';
}

export default defineConfig({
  testDir: './e2e/tests',
  globalSetup: externalBaseUrl ? undefined : './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    locale: 'es-PE',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: externalBaseUrl
    ? undefined
    : [
        {
          command: isCI ? 'pnpm --filter @ayr/api start' : 'pnpm --filter @ayr/api exec nest start',
          url: 'http://localhost:3000/health',
          reuseExistingServer: !isCI,
          timeout: 180_000,
          env: {
            PORT: '3000',
            WEB_ORIGIN: 'http://localhost:3001',
            JOBS_ENABLED: 'false',
            THROTTLE_DISABLED: 'true',
          },
        },
        {
          command: isCI ? 'pnpm --filter @ayr/web start' : 'pnpm --filter @ayr/web dev',
          url: 'http://localhost:3001/login',
          reuseExistingServer: !isCI,
          timeout: 180_000,
          env: { API_URL: 'http://localhost:3000' },
        },
      ],
});
