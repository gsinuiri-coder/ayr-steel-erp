// Genera apps/api/.env y apps/web/.env.local para desarrollo local contra Neon rama `dev`.
// Uso: pnpm env:local [--branch dev|ci]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

const branch = process.argv.includes('--branch')
  ? process.argv[process.argv.indexOf('--branch') + 1]
  : 'dev';
const setup = readEnvFile();
const pooled = neonConnectionString(branch, { pooled: true });
const direct = neonConnectionString(branch, { pooled: false });

const apiEnv = [
  `# Generado por scripts/write-local-env.mjs (rama Neon: ${branch}). No commitear.`,
  'NODE_ENV=development',
  'PORT=3000',
  `DATABASE_URL=${pooled}`,
  `DIRECT_URL=${direct}`,
  `JWT_SECRET=${setup.JWT_SECRET}`,
  'WEB_ORIGIN=http://localhost:3001',
  `ADMIN_EMAIL=${setup.ADMIN_EMAIL}`,
  `ADMIN_PASSWORD=${setup.ADMIN_PASSWORD}`,
  'JOBS_ENABLED=true',
  '',
].join('\n');
writeFileSync(resolve(ROOT, 'apps/api/.env'), apiEnv);

const webEnv = [
  '# Generado por scripts/write-local-env.mjs. No commitear.',
  'API_URL=http://localhost:3000',
  '',
].join('\n');
writeFileSync(resolve(ROOT, 'apps/web/.env.local'), webEnv);

console.log(`Listo: apps/api/.env y apps/web/.env.local apuntan a Neon rama "${branch}".`);
