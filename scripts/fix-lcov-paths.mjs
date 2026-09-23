// RF-S4b: normaliza las rutas `SF:` del lcov de la API para SonarCloud.
//
// Los tests de la API cargan `@ayr/shared` desde su fuente (`apps/api/jest.config.js`), así que el
// lcov trae también `packages/shared/src/…`. Jest escribe esas rutas relativas a `apps/api`
// (`../../packages/shared/src/x.ts`) y el scanner de SonarCloud **no las resuelve** («Could not
// resolve 33 file paths»), con lo que todo el paquete cuenta como código sin cobertura. Se
// reescriben relativas a la raíz del proyecto (`packages/shared/src/x.ts`), que sí resuelven.
// Las de la API (`src/x.ts`) ya resuelven y no se tocan. Idempotente.
//
// Uso: node ../../scripts/fix-lcov-paths.mjs coverage/lcov.info   (desde apps/api)
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Uso: fix-lcov-paths.mjs <ruta/al/lcov.info>');

const lines = readFileSync(file, 'utf8').split(/\r?\n/);
let fixed = 0;
const out = lines.map((line) => {
  if (!line.startsWith('SF:')) return line;
  const normalized = line.replace(/\\/g, '/');
  const match = /^SF:(?:\.\.\/)+(packages\/.+)$/.exec(normalized);
  if (!match) return normalized;
  fixed += 1;
  return `SF:${match[1]}`;
});
writeFileSync(file, out.join('\n'));
console.log(`lcov: ${String(fixed)} ruta(s) de packages/ reescritas a la raíz del proyecto`);
