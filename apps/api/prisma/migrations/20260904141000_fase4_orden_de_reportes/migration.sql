-- Fase 4: orden real de los reportes de piezas dentro de una orden de producción.
--
-- `created_at` no sirve para decidir cuál es el último reporte vigente: en Postgres
-- `now()` es el instante en que EMPEZÓ la transacción, así que dos reportes concurrentes
-- sobre la misma OP pueden quedar empatados o invertidos respecto al orden de commit.
-- Con eso, la regla "solo se revierte el último reporte vigente" (D-060) dejaba de ser
-- cierta justo en el caso que pretende proteger. Un `SERIAL` da el mismo orden monótono
-- que el kardex obtiene de su `id` bigserial.
ALTER TABLE "production_reports" ADD COLUMN "seq" SERIAL NOT NULL;

CREATE UNIQUE INDEX "production_reports_seq_key" ON "production_reports"("seq");
