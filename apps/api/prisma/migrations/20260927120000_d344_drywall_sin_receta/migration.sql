-- D-344: drywall deja de usar receta. El espesor y el ancho del fleje son datos del SKU
-- (`products.thickness_mm` / `products.width_mm`), y el acabado es siempre galvanizado.
--
-- La tabla `product_boms` NO se borra: las órdenes de producción históricas la referencian por
-- `production_orders.bom_id`. Deja de escribirse y de leerse, y la base rechaza que vuelva a haber
-- una receta activa.
--
-- IMPORTANTE: si la rama todavía tiene recetas activas, este ADD CONSTRAINT falla (a propósito:
-- avisa en vez de desactivarlas en silencio). Antes de migrar, desactivarlas por el servicio de
-- dominio, auditado: `pnpm retire:boms --branch <rama> --execute`. En production, el dry-run
-- (`pnpm retire:boms --branch production --confirm-production`) tiene que dar 0 activas.
ALTER TABLE "product_boms"
  ADD CONSTRAINT "product_boms_none_active_ck" CHECK (NOT "is_active");
