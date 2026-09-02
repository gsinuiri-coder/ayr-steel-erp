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

// Cloud Run corre las revisiones con la service account de Compute por defecto:
// necesita permiso explícito para leer cada secreto (no basta con roles/editor a nivel proyecto).
const projectNumber = run(
  'gcloud',
  ['projects', 'describe', project, '--format', 'value(projectNumber)'],
  { quiet: true },
).trim();
const runnerSa = `${projectNumber}-compute@developer.gserviceaccount.com`;
for (const name of Object.keys(secrets)) {
  run(
    'gcloud',
    [
      'secrets',
      'add-iam-policy-binding',
      name,
      '--project',
      project,
      '--member',
      `serviceAccount:${runnerSa}`,
      '--role',
      'roles/secretmanager.secretAccessor',
    ],
    { quiet: true },
  );
}
console.log(`- Acceso a secretos otorgado a ${runnerSa}`);

// Roles que necesita Cloud Build para desplegar con --source (subir/leer el zip fuente, empujar imagen, logs).
const builderRoles = [
  'roles/storage.objectViewer',
  'roles/cloudbuild.builds.builder',
  'roles/artifactregistry.writer',
  'roles/logging.logWriter',
];
for (const roleName of builderRoles) {
  run(
    'gcloud',
    [
      'projects',
      'add-iam-policy-binding',
      project,
      '--member',
      `serviceAccount:${runnerSa}`,
      '--role',
      roleName,
    ],
    { quiet: true },
  );
}
console.log(`- Roles de Cloud Build otorgados a ${runnerSa}`);

console.log('Secretos de GCP listos.');
