/**
 * Diagnóstico SOLO LECTURA del historial de migraciones de una rama Neon (Sesión M-1).
 * Lista las filas de `_prisma_migrations` en el orden real en que se aplicaron
 * (por `started_at`) junto con `migration_name`/`checksum`, para compararlas contra
 * las carpetas de `prisma/migrations` y encontrar el desorden exacto antes de tocar nada.
 * Se invoca desde `scripts/migrations-diagnose.mjs`, que le pasa la conexión.
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<
      {
        id: string;
        migration_name: string;
        checksum: string;
        started_at: Date;
        finished_at: Date | null;
        applied_steps_count: number;
      }[]
    >`SELECT id, migration_name, checksum, started_at, finished_at, applied_steps_count
      FROM "_prisma_migrations"
      ORDER BY started_at ASC`;

    console.warn(`Filas en _prisma_migrations: ${rows.length}`);
    console.warn('');
    for (const r of rows) {
      console.warn(
        `${r.started_at.toISOString()}  ${r.migration_name}  steps=${r.applied_steps_count}  finished=${r.finished_at ? 'sí' : 'NO'}  checksum=${r.checksum.slice(0, 12)}…`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
