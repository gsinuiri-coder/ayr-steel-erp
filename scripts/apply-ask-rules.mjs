// Aplica las reglas `ask` de P2-E (docs/handoff/fix-post-s4b.md §4) a .claude/settings.json.
//
// Existe porque el clasificador de permisos no deja al agente editar su propia configuración:
// el dueño lo corre a mano. Es idempotente: una regla que ya está no se duplica, y no quita
// ni reordena nada de lo existente.
//
// Uso (desde la raíz del checkout cuyo settings se quiere actualizar):
//   node scripts/apply-ask-rules.mjs            → muestra lo que agregaría, sin escribir
//   node scripts/apply-ask-rules.mjs --write    → lo escribe
//   node <otro-checkout>/scripts/apply-ask-rules.mjs --write   → actualiza el settings del cwd
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.cwd(), '.claude', 'settings.json');
if (!existsSync(path)) {
  console.error(`No existe ${path}. Correlo desde la raíz de un checkout del repo.`);
  process.exit(1);
}

const settings = JSON.parse(readFileSync(path, 'utf8'));
const ask = settings.permissions?.ask;
if (!Array.isArray(ask)) {
  console.error('settings.json no tiene permissions.ask; no se toca.');
  process.exit(1);
}

const wanted = [];
// Cada `Bash(node scripts/<x>.mjs*)` gana su variante con prefijo libre (./scripts, ruta absoluta).
for (const rule of ask) {
  const m = rule.match(/^Bash\(node scripts\/(.+)\)$/);
  if (m) wanted.push(`Bash(node *scripts/${m[1]})`);
}
wanted.push(
  'Bash(pnpm *e2e-admin*)',
  'Bash(pnpm *cleanup-e2e-users*)',
  'Bash(npx *e2e-admin*)',
  'Bash(npx *cleanup-e2e-users*)',
  'Bash(*tsx *prisma/e2e-admin*)',
  'Bash(*tsx *prisma/cleanup-e2e-users*)',
);

const added = wanted.filter((r) => !ask.includes(r));
if (added.length === 0) {
  console.log('Nada que agregar: las reglas de P2-E ya están.');
  process.exit(0);
}
console.log(`Reglas nuevas en permissions.ask (${added.length}):`);
for (const r of added) console.log(`  + ${r}`);

if (!process.argv.includes('--write')) {
  console.log('\nSin --write no se escribe nada.');
  process.exit(0);
}
settings.permissions.ask = [...ask, ...added];
writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`\nEscrito ${path}.`);
