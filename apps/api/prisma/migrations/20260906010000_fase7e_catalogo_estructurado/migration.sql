-- Fase 7e (D-118): campos estructurados del SKU. Nullable — solo Metallic Roofing
-- (thickness_mm, width_mm) y Drywall (width_mm, length_mm, piece_weight_kg) los exigen,
-- validado en la aplicación, no en la base.
ALTER TABLE "products" ADD COLUMN "thickness_mm" DECIMAL(6, 2);
ALTER TABLE "products" ADD COLUMN "width_mm" DECIMAL(8, 2);
ALTER TABLE "products" ADD COLUMN "length_mm" DECIMAL(8, 2);
ALTER TABLE "products" ADD COLUMN "piece_weight_kg" DECIMAL(12, 3);
