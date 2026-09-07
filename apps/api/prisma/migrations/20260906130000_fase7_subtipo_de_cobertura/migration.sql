-- D-127: subtipo de cobertura explícito (PLANCHA / A MEDIDA).
--
-- Hasta acá el subtipo se deducía de la unidad del producto (`MTR` = a medida) y del largo
-- de la receta. Ninguna pantalla lo mostraba, nadie lo podía corregir, y una cotización a
-- medida terminaba pidiendo stock de producto terminado al confirmarse.
--
-- El backfill usa exactamente la inferencia que regía hasta hoy, así que ningún producto
-- cambia de comportamiento al aplicar esta migración: lo que cambia es que a partir de acá
-- el dato está escrito y se puede corregir.

CREATE TYPE "roofing_product_kind" AS ENUM ('PLANCHA', 'A_MEDIDA');

ALTER TABLE "products" ADD COLUMN "roofing_kind" "roofing_product_kind";

UPDATE "products" p
   SET "roofing_kind" = CASE WHEN p."unit" = 'MTR' THEN 'A_MEDIDA'::"roofing_product_kind"
                             ELSE 'PLANCHA'::"roofing_product_kind" END
  FROM "business_lines" bl
 WHERE bl."id" = p."business_line_id"
   AND bl."code" = 'metallic-roofing';

-- Subtipo y unidad no pueden discrepar. Son el mismo hecho dicho dos veces ("esto se vende
-- por metro lineal" y "esto se fabrica a medida") y todo el codigo de ventas, produccion y
-- despacho ya lee la unidad. Que difieran seria reabrir la ambiguedad por el otro lado.
-- La linea de negocio no entra en el CHECK (exigiria un join); esa parte la sostiene
-- CatalogService, que es la unica puerta por la que se crea o edita un producto.
ALTER TABLE "products" ADD CONSTRAINT "products_roofing_kind_unit_check" CHECK (
  "roofing_kind" IS NULL
  OR ("roofing_kind" = 'A_MEDIDA' AND "unit" = 'MTR')
  OR ("roofing_kind" = 'PLANCHA' AND "unit" <> 'MTR')
);
