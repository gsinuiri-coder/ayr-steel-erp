-- cc53 (D-649): recosteo del promedio por fecha. OK del dueño por nombre (D-460), con este SQL.
-- Un ADJUST de recosteo apunta al movimiento cuyo costo corrige; ninguna fila se edita (la columna
-- nueva nace vacía y el trigger append-only no se toca).
-- Sin los DROP DEFAULT de operation_date: son el drift aprobado (drift-esperado.sql, D-593).

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "recost_of_id" BIGINT;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_recost_of_id_fkey" FOREIGN KEY ("recost_of_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Solo un ADJUST corrige el costo de otro movimiento.
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_recost_adjust_ck" CHECK ("recost_of_id" IS NULL OR "type" = 'ADJUST');

-- CreateIndex
CREATE INDEX "inventory_movements_recost_of_id_idx" ON "inventory_movements"("recost_of_id");
