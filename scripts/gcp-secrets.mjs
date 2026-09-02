// Crea/actualiza secretos en Secret Manager para el API en Cloud Run (nunca imprime valores).
// Uso: pnpm secrets:gcp
import { neonConnectionString, readEnvFile, run } from './lib.mjs';

const setup = readEnvFile();
const project = setup.GCP_PROJECT_ID;
const secrets = {
  DATABASE_URL: neonConnectionString('production', { pooled: true }),
  DIRECT_URL: neonConnectionString('production', { pooled: false }),
  JWT_SECRET: setup.JWT_SECRET,
};

run('gcloud', [
  'services',
  'enable',
  'secretmanager.googleapis.com',
  'run.googleapis.com',
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  '--project',
  project,
]);

for (const [name, value] of Object.entries(secrets)) {
  if (!value) throw new Error(`Secreto ${name} vacío`);
  const exists = run(
    'gcloud',
    ['secrets', 'describe', name, '--project', project, '--format', 'value(name)'],
    { allowFail: true, quiet: true },
  ).trim();
  if (!exists) {
    run(
      'gcloud',
      [
        'secrets',
        'create',
        name,
        '--project',
        project,
        '--replication-policy',
        'automatic',
        '--data-file',
        '-',
      ],
      { input: value },
    );
    console.log(`- ${name}: creado`);
  } else {
    run('gcloud', ['secrets', 'versions', 'add', name, '--project', project, '--data-file', '-'], {
      input: value,
    });
    console.log(`- ${name}: nueva versión`);
  }
}
console.log('Secretos de GCP listos.');
