// Despliega apps/api a Cloud Run desde el código fuente (Dockerfile en la raíz).
// Uso: pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app[,https://otro]
import { API_SERVICE, GCP_REGION, readEnvFile, run } from './lib.mjs';

const setup = readEnvFile();
const project = setup.GCP_PROJECT_ID;
const argIdx = process.argv.indexOf('--web-origin');
const webOrigin = argIdx > -1 ? process.argv[argIdx + 1] : process.env.WEB_ORIGIN;
if (!webOrigin || !webOrigin.split(',').every((o) => o.trim().startsWith('https://'))) {
  throw new Error(
    'Falta --web-origin https://... (orígenes CORS de producción, separados por coma, todos https)',
  );
}

// Cloud Build necesita las APIs habilitadas y el proyecto con facturación (ver PROGRESO.md B-01).
run('gcloud', [
  'run',
  'deploy',
  API_SERVICE,
  '--source',
  '.',
  '--project',
  project,
  '--region',
  GCP_REGION,
  '--platform',
  'managed',
  '--allow-unauthenticated',
  '--min-instances',
  '0',
  '--max-instances',
  '2',
  '--memory',
  '512Mi',
  '--cpu',
  '1',
  '--port',
  '8080',
  // Delimitador ^|^ porque WEB_ORIGIN puede llevar comas.
  '--set-env-vars',
  `^|^NODE_ENV=production|WEB_ORIGIN=${webOrigin}|JOBS_ENABLED=true`,
  // D-080: **producción no lleva credenciales del PSE**. Sin ellas se ata
  // `NullInvoicingProvider` y toda emisión cae en la contingencia de D-073 —toma
  // correlativo, permite despachar y queda pendiente—, que es exactamente lo que se quiere
  // mientras la única cuenta disponible es la demo: así es **imposible** que un comprobante
  // quede marcado como aceptado por SUNAT contra una cuenta de pruebas.
  //
  // El pase a la cuenta real es su propia sesión, con su checklist. Ahí se agregan
  // `NUBEFACT_URL=NUBEFACT_URL:latest` y `NUBEFACT_TOKEN=NUBEFACT_TOKEN:latest` a la lista
  // de abajo, después de cargarlas en Secret Manager.
  '--set-secrets',
  [
    'DATABASE_URL=DATABASE_URL:latest',
    'DIRECT_URL=DIRECT_URL:latest',
    'JWT_SECRET=JWT_SECRET:latest',
    'APIS_NET_PE_TOKEN=APIS_NET_PE_TOKEN:latest',
    'R2_ACCOUNT_ID=R2_ACCOUNT_ID:latest',
    'R2_ACCESS_KEY_ID=R2_ACCESS_KEY_ID:latest',
    'R2_SECRET_ACCESS_KEY=R2_SECRET_ACCESS_KEY:latest',
    'R2_BUCKET=R2_BUCKET:latest',
    'R2_ENDPOINT=R2_ENDPOINT:latest',
  ].join(','),
  '--quiet',
]);

const url = run('gcloud', [
  'run',
  'services',
  'describe',
  API_SERVICE,
  '--project',
  project,
  '--region',
  GCP_REGION,
  '--format',
  'value(status.url)',
]).trim();
console.log(`API desplegado: ${url}`);
