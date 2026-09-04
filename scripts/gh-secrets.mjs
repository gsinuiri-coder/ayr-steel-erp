// Sube a GitHub Actions los secrets que necesita CI, leyendo .env.setup (nunca imprime valores).
// Uso: pnpm secrets:gh
import { randomBytes } from 'node:crypto';
import { neonConnectionString, readEnvFile, run } from './lib.mjs';

const setup = readEnvFile();
const secrets = {
  CI_DATABASE_URL: neonConnectionString('ci', { pooled: true }),
  CI_DIRECT_URL: neonConnectionString('ci', { pooled: false }),
  JWT_SECRET: setup.JWT_SECRET,
  // Credenciales exclusivas de CI (rama ci): nunca las de producción, porque las trazas de Playwright las guardan.
  ADMIN_EMAIL: 'ci-admin@ayr.test',
  ADMIN_PASSWORD: `Ci-${randomBytes(12).toString('base64url')}`,
  SONAR_TOKEN: setup.SONAR_TOKEN ?? '',
  // D-029/D-007 (Fase 1): el E2E de CI sube archivos a R2 y consulta apis.net.pe.
  APIS_NET_PE_TOKEN: setup.APIS_NET_PE_TOKEN ?? '',
  // D-071 (Fase 5b): PSE de facturación electrónica. **Solo la cuenta demo**, sin caer
  // nunca a la de producción: un comprobante aceptado por SUNAT no se borra, se da de
  // baja, y CI corre en cada pull request. Mismo criterio que el admin efímero de arriba.
  NUBEFACT_URL: setup.NUBEFACT_DEMO_URL ?? '',
  NUBEFACT_TOKEN: setup.NUBEFACT_DEMO_TOKEN ?? '',
  R2_ACCOUNT_ID: setup.R2_ACCOUNT_ID ?? '',
  R2_ACCESS_KEY_ID: setup.R2_ACCESS_KEY_ID ?? '',
  R2_SECRET_ACCESS_KEY: setup.R2_SECRET_ACCESS_KEY ?? '',
  R2_BUCKET: setup.R2_BUCKET ?? '',
  R2_ENDPOINT: setup.R2_ENDPOINT ?? '',
};

for (const [name, value] of Object.entries(secrets)) {
  if (!value) {
    console.log(`- ${name}: vacío, se omite`);
    continue;
  }
  run('gh', ['secret', 'set', name], { input: value, quiet: true });
  console.log(`- ${name}: ok`);
}

// Variables públicas para SonarCloud (no son secretas).
if (setup.SONAR_ORG)
  run('gh', ['variable', 'set', 'SONAR_ORG', '--body', setup.SONAR_ORG], { quiet: true });
if (setup.SONAR_PROJECT_KEY)
  run('gh', ['variable', 'set', 'SONAR_PROJECT_KEY', '--body', setup.SONAR_PROJECT_KEY], {
    quiet: true,
  });
console.log('Secrets de GitHub actualizados.');
