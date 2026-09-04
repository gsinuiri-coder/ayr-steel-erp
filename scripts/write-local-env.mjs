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
  `APIS_NET_PE_TOKEN=${setup.APIS_NET_PE_TOKEN ?? ''}`,
  // D-071 (Fase 5b): PSE de facturación electrónica. Se acepta el nombre con y sin
  // `DEMO` porque el entorno de prueba y el real se guardan con claves distintas; vacío
  // es válido y deja el módulo en contingencia (D-073), que no es un fallo de arranque.
  `NUBEFACT_URL=${setup.NUBEFACT_URL ?? setup.NUBEFACT_DEMO_URL ?? ''}`,
  `NUBEFACT_TOKEN=${setup.NUBEFACT_TOKEN ?? setup.NUBEFACT_DEMO_TOKEN ?? ''}`,
  // RUC receptor de los comprobantes de prueba (Fase 5b). SUNAT valida que **exista**, así
  // que un RUC inventado con dígito verificador correcto vuelve rechazado y gasta un
  // correlativo. Decisión del dueño: se usa el RUC de la propia empresa (emisor = receptor),
  // que existe y no involucra a ningún tercero. Vacío = los E2E saltan la aceptación en vez
  // de emitir contra un RUC que no existe.
  `E2E_CUSTOMER_RUC=${setup.E2E_CUSTOMER_RUC ?? ''}`,
  `R2_ACCOUNT_ID=${setup.R2_ACCOUNT_ID ?? ''}`,
  `R2_ACCESS_KEY_ID=${setup.R2_ACCESS_KEY_ID ?? ''}`,
  `R2_SECRET_ACCESS_KEY=${setup.R2_SECRET_ACCESS_KEY ?? ''}`,
  `R2_BUCKET=${setup.R2_BUCKET ?? ''}`,
  `R2_ENDPOINT=${setup.R2_ENDPOINT ?? ''}`,
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
