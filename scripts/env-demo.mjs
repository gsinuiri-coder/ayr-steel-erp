// Escribe `.env.demo` en la raíz: el override de conexión que usa `pnpm dev:demo` para
// levantar la app local contra la rama Neon `demo` (D-125).
//
// Escribe un archivo nuevo; **nunca lee** los `.env` existentes (D-062). Las credenciales
// que no son de conexión salen de `.env.setup` por `readEnvFile`, que es la única puerta
// autorizada a ese archivo, y ninguna se imprime.
//
// Uso: pnpm env:demo
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

const target = resolve(ROOT, '.env.demo');
const setup = readEnvFile();
const pooled = neonConnectionString('demo', { pooled: true });
const direct = neonConnectionString('demo', { pooled: false });

// **Secretos propios, nunca los de producción.** `demo` es un clon de `production`: trae sus
// mismas filas de `sessions` y sus mismos ids de usuario. `AuthGuard` acepta cualquier JWT
// bien firmado cuyo `sid` exista y no esté revocado, así que compartir `JWT_SECRET` haría que
// un token acuñado contra demo —o por cualquiera que tenga este archivo— **lo acepte
// producción**, sin conocer ninguna contraseña. Se generan una vez y se reusan mientras el
// archivo exista, para no invalidar la sesión abierta en cada regeneración.
const previous = existsSync(target) ? readEnvFile(target) : {};
const jwtSecret = previous.JWT_SECRET ?? randomBytes(48).toString('base64url');
const adminPassword = previous.ADMIN_PASSWORD ?? `Demo-${randomBytes(12).toString('base64url')}`;

const lines = [
  '# Generado por scripts/env-demo.mjs (rama Neon: demo). No commitear.',
  '# Lo usa `pnpm dev:demo` para levantar la app local contra el entorno de ensayo.',
  '#',
  '# JWT_SECRET y ADMIN_PASSWORD son PROPIOS de demo y no los de producción (ver D-125):',
  '# demo es un clon de production y comparte sus sesiones, así que un secreto compartido',
  '# convertiría este archivo en una llave de producción.',
  `DATABASE_URL=${pooled}`,
  `DIRECT_URL=${direct}`,
  `JWT_SECRET=${jwtSecret}`,
  `ADMIN_EMAIL=${setup.ADMIN_EMAIL}`,
  `ADMIN_PASSWORD=${adminPassword}`,
  '',
];
writeFileSync(target, lines.join('\n'));
console.log('Listo: .env.demo apunta a la rama Neon "demo", con secretos propios.');
console.log('La contraseña del admin de demo está en .env.demo; no es la de producción.');
