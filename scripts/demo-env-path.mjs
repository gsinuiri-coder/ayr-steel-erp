// cc28: dónde vive el `.env.demo` y si una herramienta puede generarlo. Sin bash-isms (D-014).
//
// `.env.demo` lleva secretos **propios** de demo (D-125): `JWT_SECRET` y la contraseña del admin
// de demo se generan una sola vez. Antes cada script lo buscaba en la raíz del árbol donde corría,
// así que en un worktree nuevo `dev:demo` generaba otro con otra contraseña, y un `db:demo`
// posterior resembraba el admin de demo con ella (cc14). Ahora todos leen el del checkout
// principal y nadie genera uno dentro de un worktree.
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve, isAbsolute } from 'node:path';

/**
 * La raíz del checkout principal: el directorio que contiene el `.git` común. En el checkout
 * principal es `root` mismo; en un worktree, el del repositorio dueño. Si git no responde, `root`.
 */
export function mainCheckoutRoot(root) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (r.status !== 0 || !r.stdout.trim()) return resolve(root);
  return resolve(dirname(r.stdout.trim()));
}

/** `child` está dentro de `parent` (o es él). */
function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Qué `.env.demo` usar y qué hacer si falta. Función pura (se le pasa todo), para probarla.
 *
 * - La ruta: `AYR_ENV_DEMO` si viene; si no, la del checkout principal.
 * - `inWorktree`: `root` no es el checkout principal.
 * - `canGenerate`: solo desde el checkout principal y con la ruta fuera de cualquier worktree. Un
 *   worktree nunca genera: la contraseña del admin de demo quedaría en un archivo que se borra con
 *   el worktree.
 */
export function demoEnvPlan({ root, mainRoot, env = {} }) {
  const inWorktree = resolve(root) !== resolve(mainRoot);
  const path = env.AYR_ENV_DEMO ? resolve(env.AYR_ENV_DEMO) : resolve(mainRoot, '.env.demo');
  const insideWorktree = inWorktree && isInside(path, root);
  return {
    path,
    inWorktree,
    canGenerate: !inWorktree && !insideWorktree,
    howToFix:
      `Falta ${path}. El .env.demo se genera una sola vez, desde el checkout principal ` +
      `(${mainRoot}), con \`pnpm env:demo\`; desde un worktree se usa ese mismo archivo ` +
      '(o el que indique AYR_ENV_DEMO), nunca uno nuevo.',
  };
}
