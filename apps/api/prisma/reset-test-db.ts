/**
 * Reset de la base de PRUEBAS: aplica migraciones pendientes y **vacía todas las tablas**.
 * Exige `ALLOW_DB_RESET=1` explícito. Uso: `ALLOW_DB_RESET=1 pnpm exec tsx prisma/reset-test-db.ts`
 *
 * Solo contra una base de la lista blanca de `test-db-guard.ts`; ninguna otra.
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabase } from './test-db-guard';

async function main(): Promise<void> {
  const label = assertTestDatabase();
  console.warn(`Reset sobre ${label}.`);

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
