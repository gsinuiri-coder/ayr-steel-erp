/**
 * Reset de la base de PRUEBAS: aplica migraciones pendientes y **vacía todas las tablas**.
 * Exige `ALLOW_DB_RESET=1` explícito. Uso: `ALLOW_DB_RESET=1 pnpm exec tsx prisma/reset-test-db.ts`
 *
 * Las dos bases legítimas son el Postgres local de Docker (`ayr_local_e2e`) y la rama Neon
 * `ci`; ninguna otra.
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * **Lista blanca, no lista negra**, y el cambio importa desde que esto vacía **todas** las
 * tablas y no nueve.
 *
 * El guardrail anterior rechazaba el endpoint de producción y `NODE_ENV=production`, o sea que
 * dejaba pasar todo lo demás — incluida la rama Neon **`dev`**, que es lo que
 * `apps/api/.env` apunta después de un `pnpm env:local` y lo que este guion lee por
 * `dotenv/config`. Mientras el vaciado eran inventario, compras y usuarios, correrlo por error
 * contra `dev` costaba poco. Ahora se lleva también el catálogo, los clientes, las
 * cotizaciones y los comprobantes de esa rama, que es trabajo de verdad.
 *
 * Una lista negra hay que acordarse de ampliarla cada vez que aparece una base nueva; una
 * lista blanca falla sola ante lo que no reconoce, que es el lado correcto para fallar cuando
 * la operación es irreversible.
 */
const ALLOWED = [
  // Postgres de docker-compose.yml (`scripts/local-docker-env.mjs`), base exclusiva de la suite.
  { label: 'Docker local (ayr_local_e2e)', test: (u: URL) => isLocalE2E(u) },
  // Rama Neon `ci`, que se resetea en cada corrida de GitHub Actions.
  { label: 'Neon rama ci', test: (u: URL) => u.hostname.startsWith('ep-misty-band-') },
];

function isLocalE2E(url: URL): boolean {
  const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  return localHost && url.pathname.replace(/^\//, '') === 'ayr_local_e2e';
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('Falta DATABASE_URL');
  if (process.env.ALLOW_DB_RESET !== '1') {
    throw new Error('Reset bloqueado: define ALLOW_DB_RESET=1 solo para la base de pruebas');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Reset bloqueado: DATABASE_URL no es una URL que se pueda leer');
  }
  const allowed = ALLOWED.find((candidate) => candidate.test(parsed));
  if (!allowed) {
    // Sin la cadena de conexión en el mensaje: lleva la contraseña (regla dura 5). El host y
    // la base alcanzan para entender qué se estaba por borrar.
    throw new Error(
      `Reset bloqueado: ${parsed.hostname}/${parsed.pathname.replace(/^\//, '')} no es una base ` +
        `de pruebas. Solo se vacían: ${ALLOWED.map((c) => c.label).join(' o ')}.`,
    );
  }
  console.warn(`Reset sobre ${allowed.label}.`);

  execSync('pnpm exec prisma migrate deploy', { stdio: 'inherit', env: process.env });

  const prisma = new PrismaClient();
  try {
    // **Se vacía TODO menos el historial de migraciones**, y el seed repone lo que hace falta
    // (líneas de negocio, márgenes, administrador). El resultado es, tabla por tabla, el
    // estado de una base recién creada — que es exactamente lo que tiene CI, y CI está verde.
    //
    // Hasta acá la lista era de nueve tablas —inventario, compras, bobinas, sesiones,
    // auditoría y usuarios— y dejaba fuera **todos los maestros**: proveedores, colores,
    // acabados, productos y clientes sobrevivían a cada corrida y se acumulaban. Medido sobre
    // `ayr_local_e2e` en una sesión anterior: 1 874 proveedores, 841 colores, 2 902 productos,
    // 1 576 acabados y 1 195 clientes. Dos consecuencias, las dos observadas:
    //
    // 1. **409 al azar en tests que no hablan del maestro que chocó.** `suppliers.code` es
    //    `VarChar(6)`, así que los generadores sortean sobre un espacio chico contra un
    //    maestro de miles de filas: cada tantas corridas un «Ya existe un proveedor con ese
    //    código» salía desde dentro de un escenario compartido y se leía como una regresión
    //    del test que lo hospedaba. `retryingOnConflict` lo mitigaba; esto lo saca de raíz.
    // 2. **La forma de la pantalla cambiaba con la edad de la base.** Con 627 clientes el
    //    `SearchSelectField` de D-156 está siempre en modo modal, y con pocos en modo
    //    `<select>`: un spec que asumiera una sola forma pasaba en una máquina y fallaba en CI.
    //
    // Se enumera desde `information_schema` y no a mano **a propósito**: la lista escrita a
    // mano fue justamente lo que envejeció. Un modelo nuevo entra solo en el vaciado, que es
    // el comportamiento correcto para una base de pruebas descartable.
    //
    // `audit_log` e `inventory_movements` tienen trigger anti-UPDATE/DELETE: `TRUNCATE` no
    // dispara triggers de fila, así que pasa.
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT "table_name" FROM "information_schema"."tables"
      WHERE "table_schema" = 'public'
        AND "table_type" = 'BASE TABLE'
        AND "table_name" <> '_prisma_migrations'
    `;
    if (tables.length === 0) throw new Error('No se encontró ninguna tabla que vaciar');
    // Los nombres vienen del catálogo de Postgres, no de una entrada de usuario; aun así se
    // citan uno por uno para no depender de eso.
    const list = tables.map((t) => `"${t.table_name}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    console.warn(`Base de pruebas vaciada (${String(tables.length)} tablas)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
