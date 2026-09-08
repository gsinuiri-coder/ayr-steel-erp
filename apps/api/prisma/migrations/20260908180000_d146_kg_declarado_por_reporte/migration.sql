-- D-146 — kilos declarados por reporte de coberturas.
--
-- Dato **observado**, no consumo: lo que sale del kardex sigue siendo el kilo teórico de
-- los largos (D-047) y el consumo real de la corrida se reconcilia al cerrar (D-089). La
-- columna existe para que el papel de planta entre entero, reporte a reporte, y se pueda
-- comparar contra lo teórico sin esperar al cierre.
--
-- Aditiva y nullable: todo reporte anterior a D-146 queda con NULL, que es exactamente
-- "no se declaró", y ninguna lectura existente la mira.
ALTER TABLE "production_reports"
  ADD COLUMN "consumed_kg" DECIMAL(12,3);
