-- D-242, segunda mitad: el desarrollo del accesorio y los CHECK que lo sostienen.
--
-- **Aditiva**: una columna nullable y dos constraints. Ningún SKU existente cambia de forma,
-- y ninguna fila viva puede violar los CHECK nuevos (todas tienen `development_mm` NULL y un
-- `roofing_kind` que no es 'ACCESORIO').

-- El desarrollo: el ancho de fleje que se lleva una pieza del accesorio, desplegada.
ALTER TABLE "products" ADD COLUMN "development_mm" DECIMAL(8,2);

-- El CHECK de subtipo/unidad de D-127 es una lista blanca, así que el subtipo nuevo hay que
-- agregarlo a mano: sin esto, todo INSERT de un accesorio se rechaza en la base aunque la app
-- lo considere válido. `IF EXISTS` en el DROP porque la rama `production` arrastra drift
-- conocido y esta migración no puede asumir qué constraints tiene cargadas.
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_roofing_kind_unit_check";
ALTER TABLE "products" ADD CONSTRAINT "products_roofing_kind_unit_check" CHECK (
  "roofing_kind" IS NULL
  OR ("roofing_kind" = 'A_MEDIDA' AND "unit" = 'MTR')
  OR ("roofing_kind" = 'ACCESORIO' AND "unit" = 'MTR')
  OR ("roofing_kind" = 'PLANCHA' AND "unit" <> 'MTR')
);

-- El desarrollo es exactamente de los accesorios: obligatorio y positivo en ellos, nulo en
-- todo lo demás. Un desarrollo cargado en una plancha o en un perfil de drywall sería un
-- número que ninguna cuenta lee y que la próxima persona tomaría por dato bueno.
ALTER TABLE "products" ADD CONSTRAINT "products_development_mm_check" CHECK (
  ("roofing_kind" = 'ACCESORIO' AND "development_mm" IS NOT NULL AND "development_mm" > 0)
  OR ("roofing_kind" IS DISTINCT FROM 'ACCESORIO' AND "development_mm" IS NULL)
);
