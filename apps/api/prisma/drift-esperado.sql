-- # Diferencias APROBADAS entre una base creada desde cero con las migraciones y schema.prisma
-- # (SQL de `prisma migrate diff` base → schema). Las clasifica docs/analisis/drift-schema.md.
-- # Solo se reescribe con `pnpm check:drift --write` y una D-nnn que apruebe la diferencia.
-- AlterTable
ALTER TABLE "coils" ALTER COLUMN "operation_date" DROP DEFAULT;
-- AlterTable
ALTER TABLE "cutting_orders" ALTER COLUMN "operation_date" DROP DEFAULT;
-- AlterTable
ALTER TABLE "inventory_movements" ALTER COLUMN "operation_date" DROP DEFAULT;
-- AlterTable
ALTER TABLE "production_orders" ALTER COLUMN "operation_date" DROP DEFAULT;
-- AlterTable
ALTER TABLE "production_reports" ALTER COLUMN "operation_date" DROP DEFAULT;
