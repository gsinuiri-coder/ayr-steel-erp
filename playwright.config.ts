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

/**
 * Los casos que necesitan una **aceptación real del PSE** salen de la corrida por defecto y
 * se corren aparte con `pnpm e2e:pse` (que pone `E2E_PSE=1`).
 *
 * No es que sean frágiles ni lentos: es que dependen de un **recurso externo con cupo**. La
 * cuenta demo de Nubefact admite 50 comprobantes y, una vez llena, esos doce casos fallan
 * todos con «No puedes enviar mas de 50 documentos en en una cuenta DEMO». Doce rojos que no
 * son una regresión vuelven ilegible a la suite entera: quien la corre deja de mirar los
 * rojos porque «esos son los de siempre», y el día que uno sea de verdad no lo va a ver.
 *
 * **Por qué se separan por etiqueta y no ampliando `probePse`.** La sonda ya salta los casos
 * cuando no hay PSE atado o falta el RUC del receptor: eso es *no se puede llegar a una
 * aceptación en este entorno*. Agregarle «…y tampoco si respondió que no hay cupo» sería
 * enseñarle a saltear casos según **la respuesta que dio el servidor**, y esa misma condición
 * taparía una regresión que hiciera fallar la emisión por cualquier otro motivo. La exclusión
 * tiene que ser una decisión escrita en la suite, no un heurístico sobre un error.
 *
 * La corrida por defecto tiene que poder dar **verde pleno** sin depender de nada externo.
 */
const runsPse = process.env.E2E_PSE === '1';

/** Puerto del stub del padrón (`e2e/padron-stub.mjs`). Ver el `webServer` de más abajo. */
const PADRON_STUB_PORT = '3002';

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
  // Un `--grep` de la línea de comandos pisa a `grep` pero **no** a `grepInvert`, así que la
  // exclusión por defecto tiene que apagarse por entorno y no por bandera: `pnpm e2e:pse`
  // pone `E2E_PSE=1` y con eso la suite corre exactamente el complemento.
  ...(runsPse ? { grep: /@pse/ } : { grepInvert: /@pse/ }),
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
            // El padrón y el tipo de cambio se consultan **desde el API**, así que un
            // `page.route()` no los intercepta: se apuntan a un stub local. El token va con
            // un valor cualquiera porque `DocumentLookupService` corta antes de consultar si
            // está vacío (`NOT_CONFIGURED`), y con eso el badge de D-158 no se activaría nunca.
            APIS_NET_PE_BASE_URL: `http://127.0.0.1:${PADRON_STUB_PORT}`,
            APIS_NET_PE_TOKEN: 'e2e-padron-stub',
          },
        },
        {
          command: `node e2e/padron-stub.mjs ${PADRON_STUB_PORT}`,
          url: `http://127.0.0.1:${PADRON_STUB_PORT}/v1/ruc?numero=20000000000`,
          // **Nunca se reusa lo que ya escuche en ese puerto**, a diferencia del api y el web.
          // Playwright da por bueno cualquier proceso que conteste, y si ahí hay otra cosa —un
          // `next dev` que se corrió de puerto, un stub viejo de otra rama— la suite le habla
          // creyendo que es el padrón y falla con errores que no se parecen a su causa. Arranca
          // en milisegundos: no reusarlo no cuesta nada.
          reuseExistingServer: false,
          timeout: 30_000,
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
