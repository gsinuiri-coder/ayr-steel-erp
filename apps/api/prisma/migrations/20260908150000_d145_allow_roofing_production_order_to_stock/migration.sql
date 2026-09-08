-- ---------------------------------------------------------------------------
-- D-145 — una OP de coberturas nace de una reserva **o** de una meta a stock
-- ---------------------------------------------------------------------------
--
-- El `CHECK` original (Fase 6, D-084) exigía `reservation_id` en toda OP de coberturas:
-- entonces era cierto que una cobertura no existía sin el pedido que venía a cumplir.
-- D-140 (sesión 7-final) cambió esa regla —una plancha de catálogo **nunca** se fabrica
-- contra el pedido: se produce a stock (`productId` + `targetPieces`, sin reserva) y el
-- pedido espera ese saldo— pero nadie tocó el constraint, así que `createToStock` chocaba
-- contra la base con un `23514` que salía al usuario como un `500` sin explicación.
--
-- La forma nueva conserva lo que D-084 quería garantizar —**una OP de coberturas nunca es
-- huérfana**— admitiendo las dos maneras legítimas de nacer: contra la reserva de un pedido,
-- o como corrida a stock con su meta declarada. Lo que sigue prohibido es lo que siempre
-- estuvo mal: una OP de coberturas sin reserva y sin meta, que nadie sabría por qué existe.
ALTER TABLE "production_orders"
  DROP CONSTRAINT IF EXISTS "production_orders_roofing_contra_pedido";

ALTER TABLE "production_orders"
  ADD CONSTRAINT "production_orders_roofing_contra_pedido_o_a_stock"
  CHECK (
    "kind" <> 'ROOFING'
    OR "reservation_id" IS NOT NULL
    OR "target_pieces" IS NOT NULL
  );
