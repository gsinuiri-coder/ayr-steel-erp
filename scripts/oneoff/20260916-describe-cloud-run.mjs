// One-off: inspeccionar la revisión activa de Cloud Run antes/después del deploy de la
// ventana RF-S1 hotfix (2026-09-16). Solo lectura, sin credenciales.
import { run, GCP_REGION, API_SERVICE } from '../lib.mjs';

const out = run(
  'gcloud',
  [
    'run',
    'services',
    'describe',
    API_SERVICE,
    '--project',
    'ayr-steel-erp',
    '--region',
    GCP_REGION,
    '--format',
    'json',
  ],
  { quiet: true },
);
const d = JSON.parse(out);
const st = d.status || {};
const tmpl = d.spec.template;
const envs = tmpl.spec.containers[0].env || [];
console.log('latestReadyRevision:', st.latestReadyRevisionName);
console.log('traffic:', JSON.stringify(st.traffic));
console.log('template labels:', JSON.stringify(tmpl.metadata.labels));
console.log('env names:', JSON.stringify(envs.map((e) => e.name).sort()));
console.log('resources:', JSON.stringify(tmpl.spec.containers[0].resources));
console.log(
  'maxScale:',
  tmpl.metadata.annotations && tmpl.metadata.annotations['autoscaling.knative.dev/maxScale'],
);
