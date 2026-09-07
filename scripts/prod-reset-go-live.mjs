// D-129 — vacía una rama de Neon y la reconstruye desde el historial de migraciones + seed.
//
// **Es el único guion destructivo del proyecto.** Existe para una sola cosa: dejar
// `production` limpia el día del go-live, cuando lo único que hay adentro son datos de prueba
// y el kardex append-only (§3.2) hace imposible purgarlos con reversas de dominio — las fases
// 7d y 7e lo demostraron dos veces.
//
// **La ventana para usarlo se cierra el día que entra el primer dato real.** De ahí en
// adelante, la respuesta a "esto quedó sucio" vuelve a ser una reversa de dominio, nunca un
// reset. Si estás leyendo esto en una sesión futura y hay operaciones reales en la rama: no es
// la herramienta que buscás.
//
// La rama **no se borra** (eso sigue prohibido): se vacía y se vuelve a construir.
//
// Dos confirmaciones independientes, a propósito:
//   1. `AYR_CONFIRM_PROD_RESET=1` en el entorno.
//   2. `--yes-destroy <rama>` con el nombre escrito completo.
// Ninguna credencial viaja por argv (regla dura 5, D-128).
//
// Uso: AYR_CONFIRM_PROD_RESET=1 node scripts/prod-reset-go-live.mjs --branch production --yes-destroy production
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

const argv = process.argv;
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const branch = arg('--branch') ?? 'production';
const confirmed = arg('--yes-destroy');

if (process.env.AYR_CONFIRM_PROD_RESET !== '1') {
  console.error(
    [
      `BLOQUEADO: esto BORRA todos los datos de la rama "${branch}".`,
      '',
      'Si de verdad es lo que querés, corré con AYR_CONFIRM_PROD_RESET=1 y',
      `--yes-destroy ${branch}.`,
      '',
      'Antes, mirá qué hay adentro:  node scripts/go-live-inventory.mjs --branch ' + branch,
    ].join('\n'),
  );
  process.exit(1);
}
if (confirmed !== branch) {
  console.error(
    `BLOQUEADO: falta --yes-destroy ${branch} (escribiste ${confirmed ?? 'nada'}).\n` +
      'Las dos confirmaciones son independientes a propósito.',
  );
  process.exit(1);
}

const setup = readEnvFile();
const env = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: neonConnectionString(branch, { pooled: true }),
  DIRECT_URL: neonConnectionString(branch, { pooled: false }),
  ADMIN_EMAIL: setup.ADMIN_EMAIL,
  ADMIN_PASSWORD: setup.ADMIN_PASSWORD,
};
const apiDir = resolve(ROOT, 'apps/api');
const isWin = process.platform === 'win32';

function pnpm(args, label) {
  const res = spawnSync(isWin ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: apiDir,
    env,
    stdio: 'inherit',
    shell: isWin,
  });
  // El mensaje no repite los argumentos (D-128).
  if (res.status !== 0) throw new Error(`Falló: ${label}`);
}

console.log(`\nVaciando la rama "${branch}" y reconstruyéndola desde las migraciones…\n`);

pnpm(
  [
    'exec',
    'prisma',
    'db',
    'execute',
    '--file',
    'prisma/reset-schema.sql',
    '--schema',
    'prisma/schema.prisma',
  ],
  'vaciar el esquema',
);
pnpm(['exec', 'prisma', 'migrate', 'deploy'], 'aplicar migraciones');
pnpm(['exec', 'tsx', 'prisma/seed.ts'], 'sembrar el administrador y las líneas de negocio');

console.log(
  [
    '',
    `Listo. La rama "${branch}" quedó con:`,
    '  - las 5 líneas de negocio y sus márgenes por defecto',
    '  - el usuario administrador del seed',
    '  - ningún cliente, proveedor, producto, bobina, movimiento ni documento',
    '',
    'Verificalo con:  node scripts/go-live-inventory.mjs --branch ' + branch,
  ].join('\n'),
);
