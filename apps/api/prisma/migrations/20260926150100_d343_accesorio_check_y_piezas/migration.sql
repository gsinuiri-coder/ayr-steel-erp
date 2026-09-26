-- D-343 — subtipo `ACCESORIO`, paso 2 de 2: el CHECK de subtipo/unidad y las piezas informativas.
--
-- 1. Un accesorio se vende en metros lineales **de bobina** (`MTR`), como una cobertura a medida:
--    kardex, reserva, despacho y comprobante hablan en `MTR` (la unidad SUNAT es la misma). Lo que
--    lo distingue es que **no lleva detalle de largos**, y eso lo decide el subtipo con su propia
--    pregunta (`detailsLengths`), no la unidad. El CHECK sigue diciendo que subtipo y unidad no
--    pueden discrepar: `ACCESORIO` ⇒ `MTR`.
--
-- 2. `pieces_hint`: la cantidad de piezas que el usuario quiere dejar anotada en la línea de un
--    accesorio. Es solo información: no entra a ningún cálculo. Nullable y aditiva; las líneas
--    existentes quedan en NULL.

ALTER TABLE "products" DROP CONSTRAINT "products_roofing_kind_unit_check";
ALTER TABLE "products" ADD CONSTRAINT "products_roofing_kind_unit_check" CHECK (
  "roofing_kind" IS NULL
  OR ("roofing_kind" = 'A_MEDIDA' AND "unit" = 'MTR')
  OR ("roofing_kind" = 'PLANCHA' AND "unit" <> 'MTR')
  OR ("roofing_kind" = 'ACCESORIO' AND "unit" = 'MTR')
);

ALTER TABLE "quotation_items" ADD COLUMN "pieces_hint" INTEGER;
ALTER TABLE "quotation_items"
  ADD CONSTRAINT "quotation_items_pieces_hint_check" CHECK ("pieces_hint" IS NULL OR "pieces_hint" > 0);

ALTER TABLE "sales_order_items" ADD COLUMN "pieces_hint" INTEGER;
ALTER TABLE "sales_order_items"
  ADD CONSTRAINT "sales_order_items_pieces_hint_check" CHECK ("pieces_hint" IS NULL OR "pieces_hint" > 0);
