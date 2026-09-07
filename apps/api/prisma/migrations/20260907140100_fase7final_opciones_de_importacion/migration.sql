-- ---------------------------------------------------------------------------
-- Sesión 7-final, M3/M4 — opciones por lote y maestros "por completar".
-- ---------------------------------------------------------------------------

-- D-137: lo que el usuario elige **para todo el archivo** y no viene en ninguna fila: la
-- línea de negocio de las bobinas y el modo de carga (REPLAY o AJUSTE). Va en el lote y no
-- repetido en cada fila porque es una decisión del import, no un dato del Excel; y va como
-- JSON porque cada entidad tiene las suyas y no comparten forma.
ALTER TABLE "import_batches" ADD COLUMN "options" JSONB;

-- D-137: el maestro nació de una importación con el padrón de SUNAT caído, así que su
-- nombre es el que venía en el Excel y su dirección está vacía.
--
-- Es un flag y no una nota porque tiene que poder **filtrarse**: la carga de un mes puede
-- crear decenas de proveedores y clientes, y "cuáles hay que revisar" es una pregunta que
-- alguien va a hacer semanas después, cuando ya nadie recuerde qué import los creó. Lo que
-- el import NUNCA hace es trabarse esperando al tercero: un padrón caído no puede impedir
-- cargar la historia del negocio.
ALTER TABLE "suppliers" ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "suppliers_needs_review_idx" ON "suppliers"("needs_review") WHERE "needs_review";
CREATE INDEX "customers_needs_review_idx" ON "customers"("needs_review") WHERE "needs_review";
