-- ---------------------------------------------------------------------------
-- Sesión 7-final, M2 — D-122 completo: el acabado y la geometría viven en el producto,
-- y la receta queda exclusiva de drywall. Más D-139 (el peso por pieza vive en el SKU).
--
-- El dueño lo señaló en la revisión de la Fase 7e: coberturas seguía dependiendo de un
-- `ProductBom` en dos puntos (el filtro de bobina comparaba contra `input_thickness_mm`, el
-- kilo teórico del catálogo exigía una receta activa) pese a que D-118 ya había dejado
-- espesor, ancho y color en `products`. Dos fuentes del mismo dato, y la que mandaba era la
-- que menos se edita.
--
-- Después de esta migración una cobertura **no necesita receta**: su acabado (y con él la
-- densidad, RF-25), su espesor, su ancho, su largo y su color son todos del SKU.
-- ---------------------------------------------------------------------------

-- 1. El acabado del producto. Nullable en el modelo porque no todo el catálogo lo tiene
--    (trading y UPVC no llevan ninguno); la aplicación lo exige en Metallic Roofing, que
--    es donde la densidad hace falta para convertir metros en kilos.
ALTER TABLE "products" ADD COLUMN "finish_id" UUID;

ALTER TABLE "products"
  ADD CONSTRAINT "products_finish_id_fkey"
  FOREIGN KEY ("finish_id") REFERENCES "finishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "products_finish_id_idx" ON "products"("finish_id");

-- 2. Backfill desde la receta activa, que es de donde salía el dato hasta hoy.
UPDATE "products" p
SET "finish_id" = b."finish_id"
FROM "product_boms" b
WHERE b."product_id" = p."id" AND b."is_active";

-- 3. El largo de la plancha de catálogo vivía en la receta (D-083). Pasa al SKU, que es
--    donde D-118 ya había puesto el largo de la pieza de drywall: el mismo dato tiene que
--    estar en el mismo lugar en las dos líneas de negocio.
UPDATE "products" p
SET "length_mm" = b."piece_length_mm"
FROM "product_boms" b
WHERE b."product_id" = p."id"
  AND b."is_active"
  AND p."length_mm" IS NULL
  AND b."piece_length_mm" IS NOT NULL;

-- 4. D-139: el peso por pieza también pasa al SKU. `product_boms.kg_per_piece` describía
--    los kilos de fleje que consume una pieza y `products.piece_weight_kg` el peso de la
--    pieza terminada: rolar un fleje en un perfil no le saca material —el despunte se
--    reporta aparte— así que eran dos números para la misma cantidad física, y el segundo
--    es el que pertenece al producto.
UPDATE "products" p
SET "piece_weight_kg" = b."kg_per_piece"
FROM "product_boms" b
WHERE b."product_id" = p."id"
  AND b."is_active"
  AND p."piece_weight_kg" IS NULL
  AND b."kg_per_piece" IS NOT NULL;

-- 5. Una OP de coberturas ya no nace de una receta: nace del pedido y del producto.
ALTER TABLE "production_orders" ALTER COLUMN "bom_id" DROP NOT NULL;

-- 6. La receta queda **exclusiva de drywall**. Las de coberturas no se borran (el
--    histórico de OP las referencia) pero se desactivan, y el CHECK impide que vuelva a
--    haber una viva: una receta de cobertura activa sería otra vez la segunda fuente que
--    todo esto viene a cerrar.
UPDATE "product_boms" SET "is_active" = false WHERE "kind" = 'ROOFING';

ALTER TABLE "product_boms"
  ADD CONSTRAINT "product_boms_drywall_only_ck"
  CHECK ("kind" = 'DRYWALL' OR NOT "is_active");

-- 7. Las dos columnas que ya viven en el SKU dejan de existir en la receta. Lo que queda
--    en `product_boms` es exactamente el vínculo fleje → perfil: qué acabado, qué espesor y
--    qué ancho de fleje consume el producto.
ALTER TABLE "product_boms" DROP COLUMN "kg_per_piece";
ALTER TABLE "product_boms" DROP COLUMN "piece_length_mm";
