// cc59 (D-692): crea o rota AYR_CLIENT_IP_SECRET, el secreto con que la web firma la IP real del
// cliente para el API. Genera 32 bytes al azar (base64url) en este proceso y los escribe en los dos
// lados sin imprimirlos ni pasarlos por argv:
//   - Secret Manager (`AYR_CLIENT_IP_SECRET`, una versión nueva), con acceso para Cloud Run;
//   - Vercel, proyecto ayr-steel-erp-web, production y preview, como variable «sensitive».
// Después: `pnpm deploy:api` (fija la versión nueva) y un deploy de la web (Vercel toma la variable
// en el deploy siguiente). Mientras los dos no coinciden, el API ignora la IP declarada y queda el
// límite por correo: rotar no corta el login.
// Uso: node scripts/client-ip-secret.mjs
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readEnvFile, run } from './lib.mjs';

const NAME = 'AYR_CLIENT_IP_SECRET';
const VERCEL_PROJECT = 'ayr-steel-erp-web';
const project = readEnvFile().GCP_PROJECT_ID;
const value = randomBytes(32).toString('base64url');

// 1) Secret Manager.
const exists = run(
  'gcloud',
  ['secrets', 'describe', NAME, '--project', project, '--format', 'value(name)'],
  { allowFail: true, quiet: true },
).trim();
if (!exists) {
  run(
    'gcloud',
    [
      'secrets',
      'create',
      NAME,
      '--project',
      project,
      '--replication-policy',
      'automatic',
      '--data-file',
      '-',
    ],
    { input: value, quiet: true },
  );
  console.log(`- ${NAME}: creado en Secret Manager`);
} else {
  run('gcloud', ['secrets', 'versions', 'add', NAME, '--project', project, '--data-file', '-'], {
    input: value,
    quiet: true,
  });
  console.log(`- ${NAME}: versión nueva en Secret Manager`);
}
const projectNumber = run(
  'gcloud',
  ['projects', 'describe', project, '--format', 'value(projectNumber)'],
  { quiet: true },
).trim();
run(
  'gcloud',
  [
    'secrets',
    'add-iam-policy-binding',
    NAME,
    '--project',
    project,
    '--member',
    `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`,
    '--role',
    'roles/secretmanager.secretAccessor',
  ],
  { quiet: true },
);
console.log(`- ${NAME}: acceso de Cloud Run otorgado`);

// 2) Vercel (API REST con el token del CLI, como deploy-web.mjs; nunca se imprime).
function cliToken() {
  const candidates = [
    // El CLI 64 guarda el login acá; los anteriores, en xdg.data.
    resolve(process.env.APPDATA ?? '', 'com.vercel.cli/Data/auth.json'),
    resolve(process.env.APPDATA ?? '', 'xdg.data/com.vercel.cli/auth.json'),
    resolve(homedir(), '.local/share/com.vercel.cli/auth.json'),
    resolve(homedir(), 'Library/Application Support/com.vercel.cli/auth.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const token = JSON.parse(readFileSync(p, 'utf8')).token;
      if (token) return token;
    }
  }
  throw new Error('No se encontró el token del CLI de Vercel; ejecuta `vercel login`');
}
const res = await fetch(`https://api.vercel.com/v10/projects/${VERCEL_PROJECT}/env?upsert=true`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${cliToken()}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: NAME, value, type: 'sensitive', target: ['production', 'preview'] }),
});
if (!res.ok) {
  const body = await res.json().catch(() => ({}));
  throw new Error(`Vercel API: ${String(res.status)} ${body.error?.code ?? ''}`);
}
console.log(`- ${NAME}: guardado en Vercel (production y preview)`);
console.log('Siguiente: pnpm deploy:api y un deploy de la web.');
