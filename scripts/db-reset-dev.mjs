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
// Uso: node scripts/db-reset-dev.mjs --yes [--branch dev|demo] [--preserve-under-name dev-antes-de-m4]
//      node scripts/db-reset-dev.mjs --yes --branch demo --rotate-only   # solo la rotación
//
// RF-S4b: también repone `demo` desde `production` (D-227), que `docs/ENTORNOS.md` pedía hacer
// «con el CLI de Neon» sin un guion. Solo `dev` y `demo`: las otras ramas no se resetean nunca.
//
// P1-3 del delta RF-S4b: el reset le devuelve al rol `neondb_owner` la contraseña de production.
// Por eso, después del reset, el guion **rota** la contraseña de la rama por la API de Neon y
// verifica que cambió (`neon-role-rotation.mjs`). Sin `NEON_API_KEY` no se resetea nada.
import { NEON_PROJECT_ID, readEnvFile, run } from './lib.mjs';
import {
  MISSING_KEY_MESSAGE,
  resolveNeonApiKey,
  rotateRolePassword,
} from './neon-role-rotation.mjs';
import { preserveNameRefusal, resetRefusal } from './reset-guard.mjs';

const RESETTABLE = new Set(['dev', 'demo']);
const branchIdx = process.argv.indexOf('--branch');
const BRANCH = branchIdx > -1 ? process.argv[branchIdx + 1] : 'dev';
if (!RESETTABLE.has(BRANCH)) {
  console.error(`--branch solo acepta dev o demo (recibido: "${String(BRANCH)}").`);
  process.exit(1);
}
const PARENT = 'production';

if (!process.argv.includes('--yes')) {
  console.error(
    `Esto reemplaza el contenido de la rama '${BRANCH}' por el de '${PARENT}' y pierde todo\n` +
      `lo que exista solo en '${BRANCH}'. Vuelve a correrlo con --yes si es lo que quieres.\n\n` +
      `  node scripts/db-reset-dev.mjs --yes [--preserve-under-name dev-antes-de-<motivo>]`,
  );
  process.exit(1);
}

const preserveIdx = process.argv.indexOf('--preserve-under-name');
const preserveRaw = preserveIdx > -1 ? process.argv[preserveIdx + 1] : undefined;
// Sin esto, `--preserve-under-name --yes` creaba una rama llamada `--yes`.
if (preserveIdx > -1 && (!preserveRaw || preserveRaw.startsWith('-'))) {
  console.error('--preserve-under-name necesita un nombre de rama, no otra bandera.');
  process.exit(1);
}
const preserveUnderName = preserveRaw;
const rotateOnly = process.argv.includes('--rotate-only');
if (rotateOnly && preserveUnderName !== undefined) {
  console.error('--rotate-only no resetea: --preserve-under-name no tiene sentido ahí.');
  process.exit(1);
}
const nameRefusal =
  preserveUnderName === undefined ? null : preserveNameRefusal(BRANCH, preserveUnderName);
if (nameRefusal !== null) {
  console.error(nameRefusal);
  process.exit(1);
}

// P1-3: la credencial se comprueba **antes** de tocar Neon. Cortar después del reset dejaría la
// rama con la contraseña de production.
const apiKey = resolveNeonApiKey(process.env, () => readEnvFile());
if (apiKey === null) {
  console.error(MISSING_KEY_MESSAGE);
  process.exit(1);
}

// El guion promete "desde production", así que lo comprueba en vez de confiar en la
// topología: `--parent` resetea contra el padre **real**, y si algún día `dev` colgara de
// otra rama el mensaje estaría mintiendo y el contenido vendría de donde nadie pidió.
const parent = JSON.parse(
  run('neonctl', ['branches', 'get', PARENT, '--project-id', NEON_PROJECT_ID, '--output', 'json'], {
    quiet: true,
  }),
);
const target = JSON.parse(
  run('neonctl', ['branches', 'get', BRANCH, '--project-id', NEON_PROJECT_ID, '--output', 'json'], {
    quiet: true,
  }),
);
const refusal = resetRefusal(target, parent);
if (refusal !== null) {
  console.error(refusal);
  process.exit(1);
}

if (!rotateOnly) {
  // Por **id**, el mismo que acaba de pasar la cerradura: lo comprobado es lo que se resetea.
  const args = ['branches', 'reset', target.id, '--project-id', NEON_PROJECT_ID, '--parent'];
  if (preserveUnderName) args.push('--preserve-under-name', preserveUnderName);

  console.log(
    `Reseteando la rama '${BRANCH}' al estado de su padre ('${PARENT}')` +
      (preserveUnderName ? `, conservando el estado anterior como '${preserveUnderName}'` : '') +
      '…',
  );

  // `run` de `lib.mjs` ya resuelve el `cmd /c` que Windows necesita (regla dura 7).
  // Regla 3.1: en silencio y en JSON, y del JSON no se imprime nada.
  run('neonctl', [...args, '--output', 'json'], { quiet: true });
}

// P1-3: sobre el mismo id. Si falla, la rama quedó con la contraseña de production y se dice.
console.log(`Rotando la contraseña de neondb_owner en '${BRANCH}'…`);
try {
  await rotateRolePassword({ apiKey, projectId: NEON_PROJECT_ID, branchId: target.id });
} catch (err) {
  console.error(err instanceof Error ? err.message : 'La rotación falló.');
  console.error(
    `\nLa rama '${BRANCH}' tiene HOY la contraseña de production. No generes .env de ella.\n` +
      `Reintentá solo la rotación:  node scripts/db-reset-dev.mjs --yes --branch ${BRANCH} --rotate-only`,
  );
  process.exit(1);
}
console.log('Contraseña rotada y verificada distinta de la de production.');

console.log('');
console.log(`Rama '${BRANCH}' repuesta desde 'production'. Ahora, en este orden:`);
if (BRANCH === 'demo') {
  // D-227: el segundo paso no se saltea — purga las sesiones heredadas de usuarios reales.
  // P1-3: el primero tampoco: el .env.demo anterior tiene una contraseña que ya no sirve.
  console.log('  1. pnpm env:demo      # OBLIGATORIO: la contraseña de demo cambió');
  console.log(
    '  2. pnpm db:demo       # migraciones + purga de sesiones heredadas + admin de demo',
  );
} else {
  console.log('  1. pnpm env:local     # OBLIGATORIO: la contraseña de dev cambió');
  console.log('  2. pnpm db:deploy     # aplica lo que production todavía no tenga');
  console.log('  3. pnpm db:seed       # el administrador local');
}
