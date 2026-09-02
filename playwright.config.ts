import { defineConfig, devices } from '@playwright/test';

/**
 * E2E contra api (:3000) + web (:3001) locales y la DB que indique DATABASE_URL
 * (en CI: Neon rama `ci`, reseteada en global-setup). Con E2E_BASE_URL apunta a
 * una URL externa (producción) y no levanta servidores ni resetea nada.
 */
const externalBaseUrl = process.env.E2E_BASE_URL;
const baseURL = externalBaseUrl ?? 'http://localhost:3001';
const isCI = !!process.env.CI;

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
