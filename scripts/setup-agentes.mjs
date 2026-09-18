import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const hookPath = resolve(repoRoot, '.githooks', 'pre-push');

if (!existsSync(hookPath)) {
  console.error('Falta .githooks/pre-push; ejecuta este script desde la raíz del repo.');
  process.exit(1);
}

function git(args, { allowMissing = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.status !== 0 && !(allowMissing && result.status === 1)) {
    console.error(result.stderr.trim() || 'Falló git sin detalle.');
    process.exit(result.status ?? 1);
  }

  return result.stdout.trim();
}

const topLevel = resolve(git(['rev-parse', '--show-toplevel']));
if (topLevel !== resolve(repoRoot)) {
  console.error(`Ejecuta pnpm setup:agentes desde la raíz: ${topLevel}`);
  process.exit(1);
}

const currentHooksPath = git(['config', '--local', '--get', 'core.hooksPath'], {
  allowMissing: true,
});

if (currentHooksPath && currentHooksPath.replaceAll('\\', '/') !== '.githooks') {
  console.error(
    `No se reemplazó core.hooksPath=${currentHooksPath}. Revisa esa configuración manualmente.`,
  );
  process.exit(1);
}

git(['config', '--local', 'core.hooksPath', '.githooks']);

try {
  chmodSync(hookPath, 0o755);
} catch {
  // Windows no siempre expone permisos POSIX; Git ejecuta el hook mediante su shebang.
}

const antigravitySettingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
if (existsSync(antigravitySettingsPath)) {
  let antigravitySettings;
  try {
    antigravitySettings = JSON.parse(readFileSync(antigravitySettingsPath, 'utf8'));
  } catch {
    console.error(
      `No se modificó ${antigravitySettingsPath}: no contiene JSON válido. Revísalo manualmente.`,
    );
    process.exit(1);
  }

  const trustedWorkspaces = Array.isArray(antigravitySettings.trustedWorkspaces)
    ? antigravitySettings.trustedWorkspaces
    : [];
  const normalizedRepoRoot = resolve(repoRoot).toLowerCase();
  const alreadyTrusted = trustedWorkspaces.some(
    (workspace) => resolve(workspace).toLowerCase() === normalizedRepoRoot,
  );
  let settingsChanged = false;

  if (!alreadyTrusted) {
    antigravitySettings.trustedWorkspaces = [...trustedWorkspaces, resolve(repoRoot)];
    settingsChanged = true;
    console.log(`Antigravity: worktree agregado a trustedWorkspaces: ${resolve(repoRoot)}`);
  }

  const permissions =
    antigravitySettings.permissions && typeof antigravitySettings.permissions === 'object'
      ? antigravitySettings.permissions
      : {};
  const allowedPermissions = Array.isArray(permissions.allow) ? permissions.allow : [];
  const readOnlyPermissions = [
    `read_file(${resolve(repoRoot).replaceAll('\\', '/')})`,
    'command(git diff)',
    'command(git log)',
    'command(git show)',
    'command(git status)',
  ];
  const missingPermissions = readOnlyPermissions.filter(
    (permission) => !allowedPermissions.includes(permission),
  );

  if (missingPermissions.length > 0) {
    antigravitySettings.permissions = {
      ...permissions,
      allow: [...allowedPermissions, ...missingPermissions],
    };
    settingsChanged = true;
    console.log('Antigravity: permisos de lectura y diagnóstico git agregados para la revisión.');
  }

  if (settingsChanged) {
    writeFileSync(
      antigravitySettingsPath,
      `${JSON.stringify(antigravitySettings, null, 2)}\n`,
      'utf8',
    );
  }
} else {
  console.warn(
    `Antigravity no está configurado en ${antigravitySettingsPath}; se omitió trustedWorkspaces.`,
  );
}

const antigravitySkillsPath = join(homedir(), '.gemini', 'config', 'skills.json');
let antigravitySkills = { entries: [] };
if (existsSync(antigravitySkillsPath)) {
  try {
    antigravitySkills = JSON.parse(readFileSync(antigravitySkillsPath, 'utf8'));
  } catch {
    console.error(
      `No se modificó ${antigravitySkillsPath}: no contiene JSON válido. Revísalo manualmente.`,
    );
    process.exit(1);
  }
}

const skillsRoot = resolve(repoRoot, '.agents', 'skills');
const skillEntries = Array.isArray(antigravitySkills.entries) ? antigravitySkills.entries : [];
const skillsAlreadyRegistered = skillEntries.some(
  (entry) =>
    typeof entry?.path === 'string' &&
    resolve(entry.path).toLowerCase() === skillsRoot.toLowerCase(),
);

if (!skillsAlreadyRegistered) {
  antigravitySkills.entries = [...skillEntries, { path: skillsRoot }];
  mkdirSync(dirname(antigravitySkillsPath), { recursive: true });
  writeFileSync(antigravitySkillsPath, `${JSON.stringify(antigravitySkills, null, 2)}\n`, 'utf8');
  console.log(`Antigravity: skills del worktree registradas en ${antigravitySkillsPath}.`);
}

console.log('Configuración de agentes lista: core.hooksPath=.githooks.');
console.log('En el primer arranque de cada worktree usa: agy --new-project');
