-- Cierre de D-285: el kardex vuelve a ser append-only estricto, sin excepciones.
--
-- La migración 20260925010000 abrió una única puerta (cambiar `operation_date` de un movimiento
-- IMPORT dentro de una transacción con `ayr.opening_date_move = 'on'`) para fechar la carga
-- inicial al 2026-08-01. Ya se aplicó (18 movimientos, 18 auditorías
-- `inventory.opening-date.move`), así que la puerta se cierra: la función vuelve, letra por
-- letra, a la de la migración 20260903120000. Anular es insertar el movimiento inverso, nunca
-- UPDATE ni DELETE, y la variable de sesión ya no abre nada.
CREATE OR REPLACE FUNCTION inventory_movements_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements es append-only: no se permite %', TG_OP;
END;
$$ LANGUAGE plpgsql;
