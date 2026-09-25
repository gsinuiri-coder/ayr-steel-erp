// Despliega apps/api a Cloud Run desde el código fuente (Dockerfile en la raíz).
// Uso: pnpm deploy:api --web-origin https://ayr-steel-erp-web.vercel.app[,https://otro]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const gitSha = run('git', ['rev-parse', '--short', 'HEAD']).trim();

/**
 * `--set-env-vars` con el delimitador `^|^` (necesario porque `WEB_ORIGIN` puede llevar comas)
 * se rompía en Windows: `lib.mjs#run` arma el comando con `cmd /d /s /c`, y `q()` envuelve en
 * comillas cualquier argumento con `^`/`|` — la comilla queda pegada al valor que ve
 * `gcloud.cmd`, el `^|^` deja de estar al principio y gcloud no lo reconoce como delimitador:
 * termina partiendo por comas y las tres variables colapsan en una sola de nombre roto
 * (`"^|^NODE_ENV`, hallazgo de la ventana RF-S1+HOTFIX, deuda S3 #2). `--env-vars-file` no pasa
 * por ese parseo: es un YAML aparte, sin delimitadores que la shell pueda comerse.
 *
 * `--env-vars-file` **reemplaza** todas las variables planas de la revisión: lo que no esté acá
 * se borra en cada deploy. Por eso la cabecera del PEPS (D-279) vive acá y no solo en Cloud
 * Run: RUC y razón social de la empresa, confirmados por el dueño (D-287).
 */
const ENV_VARS = {
  NODE_ENV: 'production',
  WEB_ORIGIN: webOrigin,
  JOBS_ENABLED: 'true',
  COMPANY_RUC: '20608427377',
  COMPANY_LEGAL_NAME: 'PERFILES METALICOS A & R E.I.R.L.',
};
const envVarsFileDir = mkdtempSync(join(tmpdir(), 'ayr-deploy-api-'));
const envVarsFilePath = join(envVarsFileDir, 'env-vars.yaml');
try {
  writeFileSync(
    envVarsFilePath,
    Object.entries(ENV_VARS)
      .map(([k, v]) => `${k}: "${v}"`)
      .join('\n') + '\n',
  );

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
    '--env-vars-file',
    envVarsFilePath,
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
    // D-214/D-224: toda ventana cierra comparando este label contra el SHA desplegado.
    '--update-labels',
    `git-sha=${gitSha}`,
    '--quiet',
  ]);
} finally {
  rmSync(envVarsFileDir, { recursive: true, force: true });
}

// Verificación post-deploy: los nombres de variable de la revisión activa tienen que ser
// exactamente los esperados — nunca el nombre roto de antes ni uno de menos. Solo nombres,
// nunca valores (regla dura 5).
const envNames = run('gcloud', [
  'run',
  'services',
  'describe',
  API_SERVICE,
  '--project',
  project,
  '--region',
  GCP_REGION,
  '--format',
  'value(spec.template.spec.containers[0].env[].name)',
])
  // `value()` de gcloud une los elementos de una lista repetida con `;`, no con salto de
  // línea (se vio recién al correr esto por primera vez: todo el listado llegó pegado en
  // el `No esperadas` del error, con los `;` adentro).
  .trim()
  .split(/[;\r\n]+/)
  .filter(Boolean)
  .sort();
const expectedEnvNames = [...Object.keys(ENV_VARS)].sort();
const secretNames = [
  'DATABASE_URL',
  'DIRECT_URL',
  'JWT_SECRET',
  'APIS_NET_PE_TOKEN',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_ENDPOINT',
].sort();
const allExpected = [...expectedEnvNames, ...secretNames].sort();
const missing = allExpected.filter((n) => !envNames.includes(n));
const unexpected = envNames.filter((n) => !allExpected.includes(n));
if (missing.length || unexpected.length) {
  throw new Error(
    `Nombres de variable inesperados en la revisión desplegada. Faltan: [${missing.join(', ')}]. No esperadas: [${unexpected.join(', ')}].`,
  );
}
console.log('Variables de entorno/secretos de la revisión: nombres verificados, sin sorpresas.');

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
console.log(`API desplegado (git-sha=${gitSha}): ${url}`);
