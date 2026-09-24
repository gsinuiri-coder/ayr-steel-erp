// Qué hace `scripts/snapshot-reports.mjs` con sus argumentos, sin tocar la red ni Neon
// (P1-2 de la revisión del delta RF-S4b). Separado para poder probarlo.
//
// Dos reglas:
// - **No hay destino por defecto.** Antes `--base-url` caía en production, y una foto pensada
//   para demo con `--env-file .env.demo` terminaba intentando entrar a production.
// - **El admin efímero se crea en la misma base que sirve `--base-url`.** Antes se creaba
//   siempre en production, fuera cual fuera la API fotografiada, y la limpieza borraba todos los
//   `e2e-…@ayr.test` de production. Ahora `--ephemeral-admin` exige `--branch`, la rama tiene
//   que corresponder al host (production ⇔ host de production) y la limpieza borra solo el
//   correo que esta corrida creó.

import { randomBytes } from 'node:crypto';

/** Los hosts que sirven production: el dominio, los de Vercel y la API en Cloud Run. */
export function isProductionHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'v2.mareliac.pe' || h.endsWith('.vercel.app') || h.endsWith('.run.app');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Ramas Neon en las que se puede crear el admin efímero. */
export const EPHEMERAL_BRANCHES = new Set(['production', 'demo', 'dev']);

const VALUE_FLAGS = new Set(['--base-url', '--out', '--env-file', '--branch']);
const BOOLEAN_FLAGS = new Set(['--ephemeral-admin']);

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} necesita un valor.`);
      }
      flags[arg] = value;
      i += 1;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      flags[arg] = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Bandera desconocida: ${arg}.`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

/**
 * El plan de una corrida. Lanza antes de leer credenciales o tocar nada si los argumentos no
 * alcanzan o se contradicen.
 */
export function snapshotPlan(argv, { randomSuffix = () => randomBytes(6).toString('hex') } = {}) {
  const [mode, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);

  if (mode === 'compare') {
    if (positional.length !== 2) throw new Error('Uso: compare <a.json> <b.json>');
    return { mode, files: positional };
  }
  if (mode !== 'snapshot' && mode !== 'quotation') {
    throw new Error(
      'Uso: snapshot <etiqueta> | quotation <COT-nnnnnn> | compare <a.json> <b.json>',
    );
  }
  if (positional.length !== 1)
    throw new Error(`Uso: ${mode} <${mode === 'snapshot' ? 'etiqueta' : 'COT-nnnnnn'}> …`);
  if (!flags['--out']) throw new Error('Falta --out <dir>.');
  if (!flags['--base-url']) {
    throw new Error('Falta --base-url: no hay destino por defecto (nunca production sin pedirlo).');
  }

  let url;
  try {
    url = new URL(flags['--base-url']);
  } catch {
    throw new Error('--base-url no es una URL válida.');
  }
  const baseUrl = url.toString().replace(/\/$/, '');
  const production = isProductionHost(url.hostname);

  const ephemeral = flags['--ephemeral-admin'] === true;
  const branch = flags['--branch'] ?? null;
  if (branch !== null && !ephemeral) {
    throw new Error('--branch solo tiene sentido con --ephemeral-admin.');
  }
  if (ephemeral) {
    if (flags['--env-file']) {
      throw new Error('--ephemeral-admin y --env-file se excluyen: elegí una forma de entrar.');
    }
    if (branch === null) {
      throw new Error(
        '--ephemeral-admin exige --branch (production, demo o dev): la rama donde vive la base que sirve --base-url.',
      );
    }
    if (!EPHEMERAL_BRANCHES.has(branch)) {
      throw new Error(`--branch ${branch} no es válida: production, demo o dev.`);
    }
    if (production !== (branch === 'production')) {
      throw new Error(
        production
          ? `${url.hostname} es production: el admin efímero va en --branch production.`
          : `--branch production solo con un host de production, no con ${url.hostname}.`,
      );
    }
    if (!production && !LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(
        `No sé qué rama sirve ${url.hostname}: el admin efímero solo va a production o a una API local.`,
      );
    }
  }

  return {
    mode,
    target: positional[0],
    baseUrl,
    out: flags['--out'],
    envFile: flags['--env-file'] ?? null,
    ephemeral: ephemeral ? { branch, email: `e2e-snapshot-${randomSuffix()}@ayr.test` } : null,
  };
}
