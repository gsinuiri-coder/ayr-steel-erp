-- RF-S1/M1a (D-217): historial append-only de products.list_price_pen.
--
-- Additive pura: crea un tipo y una tabla, nada más. Escrita a mano por la misma razón que
-- 20260916060618_s7_fecha_emision_manual_editable: `migrate dev` arrastra el drift
-- preexistente entre schema.prisma y las migraciones, y producción está en uso real.

CREATE TYPE "PriceListChangeOrigin" AS ENUM ('INLINE', 'IMPORT');

CREATE TABLE "product_list_price_changes" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "before_value_pen" DECIMAL(18,4),
    "after_value_pen" DECIMAL(18,4),
    "changed_by_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "origin" "PriceListChangeOrigin" NOT NULL,
    "batch_id" UUID,
    "reverts_batch_id" UUID,

    CONSTRAINT "product_list_price_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "product_list_price_changes_product_id_changed_at_idx" ON "product_list_price_changes"("product_id", "changed_at");

CREATE INDEX "product_list_price_changes_batch_id_idx" ON "product_list_price_changes"("batch_id");
