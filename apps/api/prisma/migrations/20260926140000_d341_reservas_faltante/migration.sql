-- D-341 — confirmar con faltante (solo ADMINISTRADOR): `reservations.shortfall_qty`.
--
-- Lo que no se pudo reservar al confirmar. `reservations.qty` es «lo que todavía está prometido» y
-- baja con cada reporte de producción y cada despacho, así que el faltante no se puede derivar de
-- `reserve_qty − qty` una vez que la línea empezó a producirse. Se guarda como el hecho que es.
--
-- Migración aditiva: la columna nace en cero para todas las filas existentes (ninguna reserva
-- vigente tiene faltante) y el CHECK impide un valor negativo.

ALTER TABLE "reservations"
  ADD COLUMN "shortfall_qty" DECIMAL(16, 3) NOT NULL DEFAULT 0;

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_shortfall_qty_check" CHECK ("shortfall_qty" >= 0);
