-- D-073: `invoicing_settings` es una fila y solo una. Sin este índice, dos peticiones
-- concurrentes sobre una base sin la fila sembrada creaban dos, y a partir de ahí el
-- interruptor de contingencia dependía de cuál devolviera la consulta.
--
-- El índice sobre la expresión constante `(true)` es la forma estándar en Postgres de
-- decir "como mucho una fila en esta tabla".
CREATE UNIQUE INDEX "invoicing_settings_singleton" ON "invoicing_settings" ((true));
