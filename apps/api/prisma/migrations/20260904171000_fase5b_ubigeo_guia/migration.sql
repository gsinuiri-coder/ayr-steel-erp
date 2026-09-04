-- D-078: la guía de remisión exige ubigeo INEI de partida y de llegada, y el PSE la
-- rechaza sin ellos con el correlativo ya gastado (D-072). Se capturan en el despacho,
-- no al emitir la guía, para que el error salga en el formulario y no contra SUNAT.
--
-- No hay despachos todavía (la tabla nace en la migración anterior, de esta misma fase),
-- así que las columnas entran NOT NULL sin default y sin backfill.
ALTER TABLE "dispatches" ADD COLUMN "origin_ubigeo" VARCHAR(6) NOT NULL;
ALTER TABLE "dispatches" ADD COLUMN "destination_ubigeo" VARCHAR(6) NOT NULL;
