// Operación de la base de datos local (Docker): reset completo, snapshot y restore.
// Solo toca el Postgres local (docker-compose.yml); nunca Neon.
//
// Uso:
//   node scripts/db-local.mjs reset
//   node scripts/db-local.mjs snapshot <nombre>
//   node scripts/db-local.mjs restore <nombre>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';
import {
  DB_NAME_DEV,
  LOCAL_ADMIN_EMAIL,
  LOCAL_ADMIN_PASSWORD,
  LOCAL_JWT_SECRET,
  dbUrl,
} from './local-docker-env.mjs';

const apiDir = resolve(ROOT, 'apps/api');
const snapshotDir = resolve(ROOT, 'local-data/db-local-snapshots');

// Sin `shell: true`: con args en array, Node lo advierte como inseguro desde la 18.x (no
// escapa los argumentos) y no hace falta — spawnSync ya resuelve `docker`/`pnpm` por PATHEXT
// en Windows sin pasar por cmd.exe.
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (res.status !== 0) throw new Error(`Falló: ${cmd} ${args.join(' ')} (código ${res.status})`);
}

/** Como run(), pero captura stdout en vez de heredarlo (para pg_dump). */
function capture(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`Falló: ${cmd} ${args.join(' ')}\n${res.stderr}`);
  return res.stdout;
}

const [, , cmd, name] = process.argv;

if (cmd === 'reset') {
  console.log('Reseteando Postgres local: borra el volumen y lo vuelve a levantar…');
  run('docker', ['compose', 'down', '-v']);
  run('docker', ['compose', 'up', '-d', '--wait', 'db']);
  const env = {
    ...process.env,
    DATABASE_URL: dbUrl(DB_NAME_DEV),
    DIRECT_URL: dbUrl(DB_NAME_DEV),
    JWT_SECRET: LOCAL_JWT_SECRET,
    ADMIN_EMAIL: LOCAL_ADMIN_EMAIL,
    ADMIN_PASSWORD: LOCAL_ADMIN_PASSWORD,
  };
  run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: apiDir, env });
  run('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], { cwd: apiDir, env });
  console.log('Listo: Postgres local repuesto, migrado y con el admin de siempre.');
} else if (cmd === 'snapshot') {
  if (!name) throw new Error('Uso: node scripts/db-local.mjs snapshot <nombre>');
  mkdirSync(snapshotDir, { recursive: true });
  const target = resolve(snapshotDir, `${name}.sql`);
  console.log(`Volcando "${DB_NAME_DEV}" a ${target}…`);
  const dump = capture('docker', [
    'compose',
    'exec',
    '-T',
    'db',
    'pg_dump',
    '-U',
    'ayr',
    '--clean',
    '--if-exists',
    DB_NAME_DEV,
  ]);
  writeFileSync(target, dump);
  console.log('Listo (local-data/ está fuera del repo, ver .gitignore).');
} else if (cmd === 'restore') {
  if (!name) throw new Error('Uso: node scripts/db-local.mjs restore <nombre>');
  const source = resolve(snapshotDir, `${name}.sql`);
  if (!existsSync(source)) throw new Error(`No existe ${source}`);
  console.log(`Restaurando ${source} sobre "${DB_NAME_DEV}"…`);
  run('docker', ['compose', 'up', '-d', '--wait', 'db']);
  const res = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'ayr', '-d', DB_NAME_DEV],
    {
      cwd: ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      input: readFileSync(source),
    },
  );
  if (res.status !== 0) throw new Error(`Restore falló (código ${res.status})`);
  console.log('Listo.');
} else {
  console.error('Uso: node scripts/db-local.mjs reset | snapshot <nombre> | restore <nombre>');
  process.exit(1);
}
