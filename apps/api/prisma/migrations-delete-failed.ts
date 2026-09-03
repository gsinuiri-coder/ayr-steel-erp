/**
 * Borra una fila de `_prisma_migrations` que nunca terminó de aplicarse (steps=0,
 * finished_at=null), típicamente después de `prisma migrate resolve --rolled-back`.
 * Rechaza si la fila tiene `finished_at` (una migración que sí aplicó no se borra así).
 * Uso: tsx prisma/migrations-delete-failed.ts <migration_name>
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const [migrationName] = process.argv.slice(2);
  if (!migrationName) {
    throw new Error('Uso: tsx prisma/migrations-delete-failed.ts <migration_name>');
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<
      { id: string; finished_at: Date | null; applied_steps_count: number }[]
    >`SELECT id, finished_at, applied_steps_count FROM "_prisma_migrations" WHERE migration_name = ${migrationName}`;
    if (rows.length !== 1) {
      throw new Error(
        `Esperaba exactamente 1 fila con migration_name=${migrationName}, encontré ${rows.length}`,
      );
    }
    const row = rows[0];
    if (!row) {
      throw new Error(`No se encontró la fila de ${migrationName}`);
    }
    if (row.finished_at !== null || row.applied_steps_count !== 0) {
      throw new Error(
        `La fila no parece un intento fallido (finished_at=${row.finished_at?.toISOString() ?? 'null'}, applied_steps_count=${row.applied_steps_count}); no se borra.`,
      );
    }
    await prisma.$executeRaw`DELETE FROM "_prisma_migrations" WHERE id = ${row.id}`;
    console.warn(`OK: fila fallida de ${migrationName} (id=${row.id}) borrada`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
