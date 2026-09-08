-- D-153 — comprobantes manuales junto a los electrónicos.
--
-- La empresa sigue emitiendo desde otra app mientras dura la migración, y esos comprobantes
-- tienen que quedar registrados acá: con su cuenta por cobrar, su pedido y su nota de crédito,
-- pero **sin pasar por Nubefact**.
--
-- El modo es un tercer valor de `origin` y no un campo aparte, y la diferencia no es de gusto:
-- las guardas que impiden mandar un comprobante al PSE ya preguntan por `origin`, así que un
-- valor nuevo las hace cubrir el caso nuevo. Un campo ortogonal las habría dejado diciendo
-- `<> 'IMPORTED'`, o sea dejando pasar un manual a Nubefact.
ALTER TYPE "FiscalDocumentOrigin" ADD VALUE 'MANUAL';

-- El valor por defecto del selector, para no elegir el modo 70 veces durante la migración.
-- **No decide nada por sí solo**: el modo sigue a la vista y se elige comprobante por
-- comprobante; esto solo pre-selecciona.
ALTER TABLE "invoicing_settings"
  ADD COLUMN "manual_by_default" BOOLEAN NOT NULL DEFAULT false;
