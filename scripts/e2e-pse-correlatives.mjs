import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from './lib.mjs';

// BC01 no tiene último correlativo verificable; el seed PSE la desactiva antes de probar.
export const PSE_SERIES = ['F001', 'B001', 'FC01', 'T001'];
export const PSE_STEP = 100;
const MAX_CORRELATIVE = 99_999_999;

export function pseAccountFingerprint(config) {
  return createHash('sha256')
    .update(config.NUBEFACT_URL)
    .update('\0')
    .update(config.NUBEFACT_TOKEN)
    .digest('hex');
}

export function assertDemoPseConfig(localConfig, setup) {
  if (!setup.NUBEFACT_DEMO_URL || !setup.NUBEFACT_DEMO_TOKEN) {
    throw new Error('Faltan las credenciales explícitas de Nubefact demo en .env.setup');
  }
  if (
    localConfig.NUBEFACT_URL !== setup.NUBEFACT_DEMO_URL ||
    localConfig.NUBEFACT_TOKEN !== setup.NUBEFACT_DEMO_TOKEN
  ) {
    throw new Error('El gate PSE exige que apps/api/.env use la cuenta Nubefact demo');
  }
}

export function pseStatePath() {
  const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  return resolve(dirname(resolve(ROOT, commonDir)), 'local-data', 'e2e-pse-correlatives.json');
}

export function acquirePseLock(path = pseStatePath()) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err?.code === 'EEXIST') {
      throw new Error(`Ya existe ${lockPath}; conciliar la corrida PSE antes de quitar el lock`);
    }
    throw err;
  }
  return () => {
    closeSync(fd);
    unlinkSync(lockPath);
  };
}

export function pseRunEnv(inherited, bases, localUrl, pseConfig) {
  const localInherited = { ...inherited };
  delete localInherited.E2E_BASE_URL;
  return {
    ...localInherited,
    NUBEFACT_URL: pseConfig.NUBEFACT_URL,
    NUBEFACT_TOKEN: pseConfig.NUBEFACT_TOKEN,
    E2E_CUSTOMER_RUC: pseConfig.E2E_CUSTOMER_RUC,
    PSE_ENABLED: pseConfig.PSE_ENABLED,
    CI: '',
    GITHUB_ACTIONS: '',
    E2E_RESET_DB: '1',
    DATABASE_URL: localUrl,
    DIRECT_URL: localUrl,
    R2_ACCOUNT_ID: 'local-minio',
    R2_ACCESS_KEY_ID: 'ayr',
    R2_SECRET_ACCESS_KEY: 'ayr_local_minio',
    R2_BUCKET: 'ayr-e2e',
    R2_ENDPOINT: 'http://127.0.0.1:9000',
    E2E_PSE: '1',
    E2E_PSE_BASES: JSON.stringify(bases),
  };
}

export function assertPseReport(report) {
  const stats = report?.stats;
  if (
    !Number.isSafeInteger(stats?.expected) ||
    stats.expected < 1 ||
    stats.skipped !== 0 ||
    stats.unexpected !== 0 ||
    stats.flaky !== 0
  ) {
    throw new Error('El gate PSE no ejecutó todos los casos seleccionados sin saltos ni fallos');
  }
  const specs = [];
  function collect(suites) {
    for (const suite of suites ?? []) {
      specs.push(...(suite.specs ?? []));
      collect(suite.suites);
    }
  }
  collect(report.suites);
  if (
    specs.length !== stats.expected ||
    specs.some((spec) => !spec.tags?.includes('pse') || spec.tests?.length !== 1)
  ) {
    throw new Error('El reporte no contiene exclusivamente los casos @pse esperados');
  }
}

export function assertPseArguments(args) {
  if (args.some((arg) => arg.startsWith('-'))) {
    throw new Error('pnpm e2e:pse solo admite un archivo o patrón, sin opciones de Playwright');
  }
}

export function nextPseBases(lastCorrelativeBySeries) {
  const bases = {};
  for (const series of PSE_SERIES) {
    const last = lastCorrelativeBySeries?.[series];
    if (!Number.isSafeInteger(last) || last < 0 || last >= MAX_CORRELATIVE - PSE_STEP) {
      throw new Error(`Falta un último correlativo válido para ${series}`);
    }
    bases[series] = last + PSE_STEP;
  }
  return bases;
}

export function loadPseState(path = pseStatePath()) {
  if (!existsSync(path)) {
    throw new Error(
      `Falta ${path}. Registrar el último correlativo de Nubefact por serie antes de emitir pruebas.`,
    );
  }
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.version !== 1 || state.pendingBases || state.lastCorrelativeBySeries?.BC01 !== null) {
    throw new Error(
      'El estado de correlativos PSE necesita conciliación; una corrida anterior quedó pendiente.',
    );
  }
  nextPseBases(state.lastCorrelativeBySeries);
  return state;
}

export function savePseState(state, path = pseStatePath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { flag: 'w' });
}

export function assertPseObserved(bases, observed) {
  for (const series of PSE_SERIES) {
    const actual = observed?.[series];
    if (!Number.isSafeInteger(actual) || actual < bases[series] || actual > MAX_CORRELATIVE) {
      throw new Error(`No se pudo verificar el último correlativo de ${series}`);
    }
  }
}

export function confirmedPseCorrelatives(previous, bases, observed) {
  assertPseObserved(bases, observed);
  return {
    ...previous,
    ...Object.fromEntries(
      PSE_SERIES.map((series) => [
        series,
        observed[series] === bases[series] ? previous[series] : observed[series],
      ]),
    ),
  };
}
