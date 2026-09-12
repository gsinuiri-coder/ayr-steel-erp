-- D-184 (F8-S2/M1) — la cotización nace emitida.
--
-- El borrador desaparece del flujo: crear una cotización la deja emitida y editable
-- mientras no esté confirmada. Las que quedaron en borrador pasan a emitidas con la fecha de
-- alta como fecha de emisión; su PDF no existe todavía y el API lo redibuja al pedirlo.
--
-- El valor `DRAFT` **se conserva** en el enum: sacar un valor de un enum de Postgres exige
-- recrear el tipo y reescribir la columna, y la regla de la sesión es additive-first. Ningún
-- camino del código lo escribe desde esta migración.
ALTER TABLE "quotations" ALTER COLUMN "status" SET DEFAULT 'EMITTED';

UPDATE "quotations"
SET "status" = 'EMITTED',
    "emitted_at" = COALESCE("emitted_at", "created_at")
WHERE "status" = 'DRAFT';
