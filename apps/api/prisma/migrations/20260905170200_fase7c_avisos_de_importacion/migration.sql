-- RF-72: una fila de importación puede traer algo que el usuario tiene que ver antes de
-- confirmar sin que lo bloquee ("esta fila archiva la versión anterior de F001-00000123").
-- `errors` no sirve para eso: lo que está en `errors` no se confirma.
ALTER TABLE "import_rows" ADD COLUMN "warnings" JSONB;
