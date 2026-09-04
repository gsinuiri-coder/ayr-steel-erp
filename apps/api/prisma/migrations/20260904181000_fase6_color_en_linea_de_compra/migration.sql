-- Fase 6 (D-085): el color de la bobina se elige al registrar la compra, que es donde el
-- almacenero tiene el rollo delante. El XML de factura no trae color, así que esas bobinas
-- nacen sin él y se lo pone después la edición de la bobina (RF-20).
ALTER TABLE "purchase_items" ADD COLUMN "color_id" UUID;
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_color_id_fkey" FOREIGN KEY ("color_id") REFERENCES "colors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
