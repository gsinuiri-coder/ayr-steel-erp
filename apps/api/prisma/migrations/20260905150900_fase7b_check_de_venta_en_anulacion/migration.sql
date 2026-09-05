-- D-100: `VOIDING` es el estado en el que la venta ya está reclamada y la cadena de reversas
-- todavía no terminó. Va en su propia migración porque Postgres no admite usar un valor de
-- enum recién agregado dentro de la misma transacción que lo agregó.
--
-- El `CHECK` pasa a exigir las tres marcas de anulación desde el **reclamo**, no desde el
-- final: quién, cuándo y por qué se saben al empezar, y guardarlos ahí es lo que permite que
-- un reintento sepa qué estaba haciendo la anulación que se cortó.
ALTER TABLE "pos_sales" DROP CONSTRAINT "pos_sales_void_ck";
ALTER TABLE "pos_sales" ADD CONSTRAINT "pos_sales_void_ck" CHECK (
  ("status" IN ('VOIDING', 'VOIDED')
     AND "voided_by_id" IS NOT NULL AND "voided_at" IS NOT NULL AND "void_reason" IS NOT NULL)
  OR
  ("status" = 'ACTIVE'
     AND "voided_by_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
);
