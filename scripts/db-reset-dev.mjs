// Devuelve la rama `dev` de Neon al estado de `production` (D-111).
//
// Existe porque hay residuo de pruebas que **no se puede borrar por la aplicación**: desde
// RF-71 un comprobante importado no se elimina, y aunque desde D-110 se anula, la fila y su
// serie inactiva quedan. Limpiar eso con SQL a mano sobre una base con historial fiscal es
// justo lo que este proyecto no hace, así que la salida es reponer la rama entera.
//
// **Resetea, no borra** (`neonctl branches reset dev --parent`): la regla dura del proyecto
// prohíbe borrar ramas de Neon, y un `delete` + `create` además cambiaría el endpoint y
// dejaría inservibles las cadenas de conexión de todos lados. El reset conserva el id, el
// nombre y el endpoint de la rama; lo único que cambia es su contenido, que pasa a ser una
// copia del de `production` en este instante.
//
// Lo que se pierde: **todo** lo que viva solo en `dev`. Es el punto del guion, y por eso
// exige `--yes`.
//
// Uso: node scripts/db-reset-dev.mjs --yes [--preserve-under-name dev-antes-de-m4]
import { spawnSync } from 'node:child_process';
import { NEON_PROJECT_ID } from './lib.mjs';

const BRANCH = 'dev';

if (!process.argv.includes('--yes')) {
  console.error(
    `Esto reemplaza el contenido de la rama '${BRANCH}' por el de 'production' y pierde todo\n` +
      `lo que exista solo en '${BRANCH}'. Vuelve a correrlo con --yes si es lo que quieres.\n\n` +
      `  node scripts/db-reset-dev.mjs --yes [--preserve-under-name dev-antes-de-<motivo>]`,
  );
  process.exit(1);
}

const preserveIdx = process.argv.indexOf('--preserve-under-name');
const preserveUnderName = preserveIdx > -1 ? process.argv[preserveIdx + 1] : undefined;

const args = ['branches', 'reset', BRANCH, '--project-id', NEON_PROJECT_ID, '--parent'];
if (preserveUnderName) args.push('--preserve-under-name', preserveUnderName);

console.log(
  `Reseteando la rama '${BRANCH}' al estado de su padre ('production')` +
    (preserveUnderName ? `, conservando el estado anterior como '${preserveUnderName}'` : '') +
    '…',
);

// `neonctl` en Git Bash necesita pasar por cmd.exe en Windows, igual que `gcloud`.
const res = spawnSync(
  process.platform === 'win32' ? 'cmd' : 'neonctl',
  process.platform === 'win32' ? ['/c', 'neonctl', ...args] : args,
  { stdio: 'inherit' },
);
if ((res.status ?? 1) !== 0) {
  console.error('El reset falló. La rama quedó como estaba.');
  process.exit(res.status ?? 1);
}

console.log('');
console.log(`Rama '${BRANCH}' repuesta desde 'production'. Ahora, en este orden:`);
console.log('  1. pnpm env:local     # el endpoint no cambió, pero deja el .env al día');
console.log('  2. pnpm db:deploy     # aplica lo que production todavía no tenga');
console.log('  3. pnpm db:seed       # el administrador local');
