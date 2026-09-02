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
