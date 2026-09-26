-- D-343 — subtipo de cobertura `ACCESORIO` (cumbrera, canal, remate…): paso 1 de 2, el valor del enum.
--
-- Un valor nuevo de enum no se puede **usar** en la misma transacción que lo agrega (Postgres:
-- «unsafe use of new value»), y el CHECK de la migración siguiente lo nombra. Por eso son dos
-- migraciones. Esta no cambia el comportamiento de ningún dato existente: nadie tiene todavía un
-- producto con este subtipo.

ALTER TYPE "roofing_product_kind" ADD VALUE IF NOT EXISTS 'ACCESORIO';
