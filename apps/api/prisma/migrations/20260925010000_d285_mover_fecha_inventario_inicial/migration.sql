-- D-285: excepción puntual a la regla append-only del kardex, decidida por el dueño.
--
-- La carga inicial (ref_type = 'IMPORT') quedó fechada el día en que se cargó (15-09 las
-- bobinas, 22-09 el UPVC), así que las ventas de agosto caían antes del saldo inicial. El dueño
-- decidió fecharla el 2026-08-01 (HISTORICAL_LOAD_START). Lo único que se permite cambiar es
-- `operation_date` de un movimiento IMPORT, y solo dentro de una transacción que declare
-- `SET LOCAL ayr.opening_date_move = 'on'` — la pone únicamente
-- `OpeningDateMoveService.execute`, que se niega si la auditoría ya registra el movimiento.
-- Cualquier otro UPDATE o DELETE sigue rechazado como siempre.
CREATE OR REPLACE FUNCTION inventory_movements_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('ayr.opening_date_move', true) = 'on'
     AND OLD."ref_type" = 'IMPORT'
     AND (to_jsonb(NEW) - 'operation_date') = (to_jsonb(OLD) - 'operation_date')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'inventory_movements es append-only: no se permite %', TG_OP;
END;
$$ LANGUAGE plpgsql;
