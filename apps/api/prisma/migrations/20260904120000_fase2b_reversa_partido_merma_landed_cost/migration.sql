-- Fase 2b (D-041): reversa de movimientos de kardex, partido de bobina, merma,
-- cierre/edicion/anulacion de bobina, anulacion de compra recibida y landed cost.
--
-- Notas:
--  * ServiceKind gana CUSTOMS e INSURANCE (D-043). PG 12+ admite varios ADD VALUE en
--    una transaccion mientras los valores nuevos no se usen en esa misma transaccion;
--    esta migracion no los usa. Neon corre PG 17.
--  * inventory_movements.notes guarda el motivo de la merma (RF-17) y el de cada
--    anulacion (RF-18, RF-21). El trigger append-only de Fase 2a sigue vigente.
--  * coil_splits agrupa la salida de la madre y las entradas de las hijas de un
--    partido (RF-15) para poder revertirlo entero (RF-16).
-- CreateEnum
CREATE TYPE "CoilSplitStatus" AS ENUM ('ACTIVE', 'REVERTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ServiceKind" ADD VALUE 'CUSTOMS';
ALTER TYPE "ServiceKind" ADD VALUE 'INSURANCE';

-- AlterTable
ALTER TABLE "coils" ADD COLUMN     "notes" VARCHAR(500),
ADD COLUMN     "split_id" UUID;

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "notes" VARCHAR(240);

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "related_purchase_id" UUID;

-- CreateTable
CREATE TABLE "coil_splits" (
    "id" UUID NOT NULL,
    "parent_coil_id" UUID NOT NULL,
    "split_weight_kg" DECIMAL(12,3) NOT NULL,
    "kerf_loss_mm" DECIMAL(8,2) NOT NULL,
    "kerf_loss_kg" DECIMAL(12,3) NOT NULL,
    "status" "CoilSplitStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_by_id" UUID,
    "reverted_at" TIMESTAMPTZ(3),

    CONSTRAINT "coil_splits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coil_splits_parent_coil_id_idx" ON "coil_splits"("parent_coil_id");

-- CreateIndex
CREATE INDEX "coils_parent_coil_id_idx" ON "coils"("parent_coil_id");

-- CreateIndex
CREATE INDEX "coils_split_id_idx" ON "coils"("split_id");

-- CreateIndex
CREATE INDEX "purchases_related_purchase_id_idx" ON "purchases"("related_purchase_id");

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_related_purchase_id_fkey" FOREIGN KEY ("related_purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coils" ADD CONSTRAINT "coils_split_id_fkey" FOREIGN KEY ("split_id") REFERENCES "coil_splits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coil_splits" ADD CONSTRAINT "coil_splits_parent_coil_id_fkey" FOREIGN KEY ("parent_coil_id") REFERENCES "coils"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

