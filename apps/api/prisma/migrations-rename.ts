/**
 * Sincroniza `_prisma_migrations.migration_name` tras renombrar SOLO el nombre de una
 * carpeta de migración ya aplicada (nunca su .sql). Verifica que exista exactamente una
 * fila con el nombre viejo y que el checksum no cambie antes y después del UPDATE.
 * Uso: tsx prisma/migrations-rename.ts <nombre_viejo> <nombre_nuevo>
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const [oldName, newName] = process.argv.slice(2);
  if (!oldName || !newName) {
    throw new Error('Uso: tsx prisma/migrations-rename.ts <nombre_viejo> <nombre_nuevo>');
  }

  const prisma = new PrismaClient();
  try {
    const before = await prisma.$queryRaw<{ id: string; checksum: string }[]>`
      SELECT id, checksum FROM "_prisma_migrations" WHERE migration_name = ${oldName}
    `;
    if (before.length !== 1) {
      throw new Error(
        `Esperaba exactamente 1 fila con migration_name=${oldName}, encontré ${before.length}`,
      );
    }
    const dupNew = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "_prisma_migrations" WHERE migration_name = ${newName}
    `;
    if (dupNew.length !== 0) {
      throw new Error(`Ya existe una fila con migration_name=${newName}`);
    }

    await prisma.$executeRaw`
      UPDATE "_prisma_migrations" SET migration_name = ${newName} WHERE migration_name = ${oldName}
    `;

    const after = await prisma.$queryRaw<{ id: string; checksum: string }[]>`
      SELECT id, checksum FROM "_prisma_migrations" WHERE migration_name = ${newName}
    `;
    const beforeRow = before[0];
    const afterRow = after[0];
    if (
      !afterRow ||
      !beforeRow ||
      after.length !== 1 ||
      afterRow.id !== beforeRow.id ||
      afterRow.checksum !== beforeRow.checksum
    ) {
      throw new Error('Verificación post-UPDATE falló: id o checksum cambiaron inesperadamente');
    }

    console.warn(`OK: ${oldName} -> ${newName} (id=${afterRow.id}, checksum sin cambios)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
