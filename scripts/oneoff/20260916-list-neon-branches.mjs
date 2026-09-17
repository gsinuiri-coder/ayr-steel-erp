// One-off: listar ramas Neon (solo lectura) para el cierre de la ventana RF-S1+HOTFIX
// (2026-09-16). Verifica nombre/id de respaldos antes de escribir PROGRESO.md.
import { run, NEON_PROJECT_ID } from '../lib.mjs';

const out = run(
  'neonctl',
  ['branches', 'list', '--project-id', NEON_PROJECT_ID, '--output', 'json'],
  { quiet: true },
);
const branches = JSON.parse(out);
for (const b of branches) {
  console.log(b.name, '|', b.id, '|', b.created_at, '|', b.default ? 'default' : '');
}
console.log('total:', branches.length);
