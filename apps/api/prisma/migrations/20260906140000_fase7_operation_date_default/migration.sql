-- D-124: DEFAULT de la fecha de operación, en zona de Lima.
--
-- Hallazgo de la revisión. Las columnas quedaron NOT NULL sin DEFAULT, y entre aplicar las
-- migraciones (`pnpm db:prod`) y desplegar el código nuevo (`pnpm deploy:api`) la revisión
-- anterior del API sigue sirviendo tráfico: inserta sin conocer la columna, y sin DEFAULT
-- toda alta de kardex, bobina, orden de corte, OP o reporte de piezas fallaría con violación
-- de NOT NULL durante toda esa ventana. Sobre datos reales eso son 500s en cada operación de
-- planta.
--
-- Es `(now() AT TIME ZONE 'America/Lima')::date` y no `CURRENT_DATE`, que da el día en UTC y
-- repetiría el desfase de cinco horas de D-112 entre las 19:00 y la medianoche local.
--
-- El DEFAULT no debilita nada: la aplicación siempre manda la fecha explícita (resuelta por
-- `OperationDateService`); esto solo cubre a un escritor que no conozca la columna.

ALTER TABLE "inventory_movements" ALTER COLUMN "operation_date" SET DEFAULT (now() AT TIME ZONE 'America/Lima')::date;
ALTER TABLE "coils" ALTER COLUMN "operation_date" SET DEFAULT (now() AT TIME ZONE 'America/Lima')::date;
ALTER TABLE "cutting_orders" ALTER COLUMN "operation_date" SET DEFAULT (now() AT TIME ZONE 'America/Lima')::date;
ALTER TABLE "production_orders" ALTER COLUMN "operation_date" SET DEFAULT (now() AT TIME ZONE 'America/Lima')::date;
ALTER TABLE "production_reports" ALTER COLUMN "operation_date" SET DEFAULT (now() AT TIME ZONE 'America/Lima')::date;
