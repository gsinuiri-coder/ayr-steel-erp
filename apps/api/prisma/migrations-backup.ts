/**
 * Backup SOLO LECTURA de `_prisma_migrations` antes de tocar el historial (Sesión M-1).
 * Escribe el contenido completo de la tabla como JSON a stdout; el caller
 * (`scripts/migrations-backup.mjs`) lo redirige al archivo de destino.
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw`SELECT * FROM "_prisma_migrations" ORDER BY started_at ASC`;
    process.stdout.write(JSON.stringify(rows, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
