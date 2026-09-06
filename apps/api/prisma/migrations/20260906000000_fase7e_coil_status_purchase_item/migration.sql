-- Fase 7e (D-116): estado con el que nace la bobina de una línea de compra COIL.
-- Nullable: solo lo usan las líneas COIL; el resto de tipos de compra la dejan en null.
ALTER TABLE "purchase_items" ADD COLUMN "coil_status" "CoilStatus";
