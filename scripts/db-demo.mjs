// Prepara la rama `demo` de Neon (D-125): migraciones, purga de sesiones heredadas y seed del
// administrador **de demo**.
//
// Solo `prisma migrate deploy` (nunca reset), igual que `db:prod`: la rama demo se rehace
// clonándola de production, no borrando tablas.
//
// Los secretos salen de `.env.demo` (que `scripts/env-demo.mjs` genera con valores **propios**,
// nunca los de producción) y no de `.env.setup`. El motivo está en D-125: demo es un clon de
// production y hereda sus `sessions` y sus ids de usuario, así que compartir `JWT_SECRET`
// convertiría a demo en una llave de producción.
//
// **Nada de esto viaja por argv.** Las cadenas de conexión van solo por el entorno del proceso
// hijo: un argumento aparece en el título del proceso y —lo que de verdad pasó al escribir este
// script— en el mensaje de error cuando el comando falla. Regla dura 5.
//
// Uso: pnpm db:demo
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, neonConnectionString, readEnvFile } from './lib.mjs';

const demoEnvPath = resolve(ROOT, '.env.demo');
if (!existsSync(demoEnvPath)) {
  const res = spawnSync(process.execPath, [resolve(ROOT, 'scripts/env-demo.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('No se pudo generar .env.demo');
}
const demo = readEnvFile(demoEnvPath);

const env = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: neonConnectionString('demo', { pooled: true }),
  DIRECT_URL: neonConnectionString('demo', { pooled: false }),
  JWT_SECRET: demo.JWT_SECRET,
  ADMIN_EMAIL: demo.ADMIN_EMAIL,
  ADMIN_PASSWORD: demo.ADMIN_PASSWORD,
};
const apiDir = resolve(ROOT, 'apps/api');
const isWin = process.platform === 'win32';

function pnpm(args) {
  const res = spawnSync(isWin ? 'pnpm.cmd' : 'pnpm', args, {
    cwd: apiDir,
    env,
    stdio: 'inherit',
    shell: isWin,
  });
  // El mensaje no repite los argumentos: aunque hoy ninguno lleve credenciales, un `--url` que
  // alguien agregue mañana terminaría impreso en el log de un fallo.
  if (res.status !== 0) throw new Error(`Falló "pnpm ${args[1]} ${args[2] ?? ''}" contra demo`);
}

pnpm(['exec', 'prisma', 'migrate', 'deploy']);

// **Las sesiones heredadas se borran siempre.** Un clon de production trae sus refresh tokens
// vivos; dejarlos conservaría la única pieza que un secreto compartido necesitaría para cruzar
// de un entorno al otro. Es barato y no se puede olvidar si vive acá y no en una lista de pasos
// manuales. La conexión la toma del `DIRECT_URL` del entorno, no de un `--url` en argv.
pnpm([
  'exec',
  'prisma',
  'db',
  'execute',
  '--file',
  'prisma/demo-purge-sessions.sql',
  '--schema',
  'prisma/schema.prisma',
]);

pnpm(['exec', 'tsx', 'prisma/seed.ts']);
console.log('Demo: migraciones aplicadas, sesiones heredadas purgadas y seed listo.');
console.log('El administrador de demo usa la contraseña de .env.demo, no la de producción.');
