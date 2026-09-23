-- RF-S4b / D-253: unión de productos. Aditiva: una columna nullable, su índice, la FK y un
-- CHECK. Todas las filas existentes quedan con NULL y el CHECK las acepta.
--
-- Las tres primeras sentencias las generó `prisma migrate diff` desde `schema.prisma`
-- (`Product.mergedIntoId`, `@relation("ProductMerge", onDelete: Restrict)`, `@@index`). El CHECK
-- no se puede expresar en el schema de Prisma y se agrega a mano, como el de D-203.

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "merged_into_id" UUID;

-- CreateIndex
CREATE INDEX "products_merged_into_id_idx" ON "products"("merged_into_id");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Un producto unido está inactivo y no se apunta a sí mismo. Que el principal no sea a su vez
-- un producto unido (sin cadenas) lo impone el servicio de unión: un CHECK no puede mirar otra
-- fila.
ALTER TABLE "products"
  ADD CONSTRAINT "products_merged_into_inactive_chk"
  CHECK ("merged_into_id" IS NULL OR ("is_active" = false AND "merged_into_id" <> "id"));
