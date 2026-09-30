// Corre únicamente las pruebas etiquetadas @pse contra Docker E2E y Nubefact demo.
// Uso: pnpm e2e:pse [<archivo o patrón>]. La cuenta demo debe tener crédito.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  DB_NAME_E2E,
  LOCAL_ADMIN_EMAIL,
  LOCAL_ADMIN_PASSWORD,
  LOCAL_JWT_SECRET,
  dbUrl,
} from './local-docker-env.mjs';
import { ROOT, readEnvFile, run } from './lib.mjs';
import {
  PSE_SERIES,
  acquirePseLock,
  assertDemoPseConfig,
  assertPseArguments,
  assertPseReport,
  confirmedPseCorrelatives,
  loadPseState,
  nextPseBases,
  pseAccountFingerprint,
  pseRunEnv,
  savePseState,
} from './e2e-pse-correlatives.mjs';

const passthrough = process.argv.slice(2);
assertPseArguments(passthrough);
if (process.env.E2E_BASE_URL) {
  throw new Error('pnpm e2e:pse solo corre contra Docker local');
}

const localConfig = readEnvFile(resolve(ROOT, 'apps/api/.env'));
if (
  !localConfig.NUBEFACT_URL ||
  !localConfig.NUBEFACT_TOKEN ||
  !localConfig.E2E_CUSTOMER_RUC ||
  localConfig.PSE_ENABLED !== 'true'
) {
  throw new Error('Falta configurar PSE y RUC de prueba en apps/api/.env');
}
assertDemoPseConfig(localConfig, readEnvFile());

const release = acquirePseLock();
try {
  const state = loadPseState();
  const accountFingerprint = pseAccountFingerprint(localConfig);
  if (state.accountFingerprint && state.accountFingerprint !== accountFingerprint) {
    throw new Error('El estado de correlativos corresponde a otra cuenta PSE');
  }
  const bases = nextPseBases(state.lastCorrelativeBySeries);
  const localUrl = dbUrl(DB_NAME_E2E);
  const reportPath = resolve(ROOT, 'local-data/e2e-pse-report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  if (existsSync(reportPath)) unlinkSync(reportPath);
  run('pnpm', ['exec', 'tsx', 'prisma/e2e-minio-preflight.ts'], {
    cwd: resolve(ROOT, 'apps/api'),
    env: pseRunEnv(process.env, bases, localUrl, localConfig),
    quiet: true,
  });
  savePseState({ ...state, accountFingerprint, pendingBases: bases });
  console.log(
    'Correlativos PSE reservados: ' + PSE_SERIES.map((s) => `${s}:${bases[s]}`).join(', '),
  );

  const res = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'playwright', 'test', '--reporter=list,json', ...passthrough],
    {
      cwd: ROOT,
      env: {
        ...pseRunEnv(process.env, bases, localUrl, localConfig),
        JWT_SECRET: LOCAL_JWT_SECRET,
        ADMIN_EMAIL: LOCAL_ADMIN_EMAIL,
        ADMIN_PASSWORD: LOCAL_ADMIN_PASSWORD,
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  if (res.status !== 0) {
    console.error(
      'Corrida PSE fallida; conciliar los correlativos de Nubefact antes de reintentar.',
    );
    process.exitCode = res.status ?? 1;
  } else {
    assertPseReport(JSON.parse(readFileSync(reportPath, 'utf8')));
    const observed = JSON.parse(
      run('pnpm', ['exec', 'tsx', 'prisma/e2e-pse-series.ts'], {
        cwd: resolve(ROOT, 'apps/api'),
        env: {
          DATABASE_URL: localUrl,
          DIRECT_URL: localUrl,
          ALLOW_DB_RESET: '1',
          E2E_PSE_BASES: JSON.stringify(bases),
        },
        quiet: true,
      }),
    );
    const confirmed = confirmedPseCorrelatives(state.lastCorrelativeBySeries, bases, observed);
    savePseState({ version: 1, accountFingerprint, lastCorrelativeBySeries: confirmed });
    console.log('Gate PSE verde; siguiente corrida comenzará 100 después del último por serie.');
  }
} finally {
  release();
}
