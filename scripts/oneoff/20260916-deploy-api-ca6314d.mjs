// One-off: deploy de la API a Cloud Run con label git-sha=ca6314d (ventana RF-S1 hotfix,
// 2026-09-16). Corre desde el worktree en ese SHA. Sin flags de env/secretos (D-217 hallazgo
// colateral: --set-env-vars los rompe en Windows). Usa lib.mjs#run, credenciales nunca por argv.
import { run, GCP_REGION, API_SERVICE } from '../lib.mjs';

run(
  'gcloud',
  [
    'run',
    'deploy',
    API_SERVICE,
    '--source',
    '.',
    '--project',
    'ayr-steel-erp',
    '--region',
    GCP_REGION,
    '--update-labels',
    'git-sha=ca6314d',
    '--quiet',
  ],
  { cwd: 'C:/Users/User/Documents/workspace/ayr/ayr-release-ca6314d', inherit: true },
);
