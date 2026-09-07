-- ---------------------------------------------------------------------------
-- Sesión 7-final, M1 — la reserva de materia prima deja de apuntar a una bobina
-- concreta y pasa a apuntar al **agregado compatible** (D-134).
--
-- El caso real: el vendedor cotiza coberturas a medida semanas antes de que planta
-- las role. Pedirle que elija el rollo físico lo obliga a comprometer una bobina que
-- todavía no se sabe cuál va a ser —la elige planta al montar la OP, D-086—, y a
-- cotizar contra un stock que puede no existir el día de la cotización.
--
-- Lo que la línea promete ahora son **kilos de un agregado**: misma línea de negocio,
-- mismo color y espesor dentro de la tolerancia (D-086). Ese agregado es una fila de
-- `raw_material_specs`, y es a esa fila a la que apunta la reserva
-- (`item_type = 'RAW_MATERIAL'`). La invariante `disponible ≥ reservado` se sostiene
-- sobre la **suma** de las bobinas compatibles, no sobre una sola.
-- ---------------------------------------------------------------------------

-- El agregado. No es un ítem de inventario: no tiene saldo propio ni movimientos, es
-- la **descripción** de qué material sirve. El saldo lo ponen las bobinas que la
-- cumplen, y por eso las dos tablas del kardex se cierran explícitamente a este valor
-- del enum más abajo.
CREATE TABLE "raw_material_specs" (
  "id"               UUID          NOT NULL,
  "business_line_id" UUID          NOT NULL,
  "color_id"         UUID,
  -- Espesor de entrada que pide la receta, en mm. La tolerancia no se guarda: es
  -- configuración vigente (ROOFING_THICKNESS_TOLERANCE_MM) y se aplica al comparar.
  "thickness_mm"     DECIMAL(6,2)  NOT NULL,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "raw_material_specs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "raw_material_specs"
  ADD CONSTRAINT "raw_material_specs_business_line_id_fkey"
  FOREIGN KEY ("business_line_id") REFERENCES "business_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "raw_material_specs"
  ADD CONSTRAINT "raw_material_specs_color_id_fkey"
  FOREIGN KEY ("color_id") REFERENCES "colors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Un agregado por combinación. El `COALESCE` es lo que hace que "sin color" sea **una**
-- combinación y no infinitas: Postgres trata los NULL como distintos y un UNIQUE normal
-- dejaría entrar dos filas idénticas sin color (mismo motivo que `fiscal_series`).
CREATE UNIQUE INDEX "raw_material_specs_key" ON "raw_material_specs"(
  "business_line_id",
  COALESCE("color_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "thickness_mm"
);

-- El kardex no mueve agregados. Un movimiento o un saldo con `RAW_MATERIAL` sería un
-- saldo que nadie alimenta; el enum es compartido con `reservations` y esto es lo que
-- mantiene honesta esa frontera.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_item_type_ck" CHECK ("item_type" <> 'RAW_MATERIAL');

ALTER TABLE "inventory_balances"
  ADD CONSTRAINT "inventory_balances_item_type_ck" CHECK ("item_type" <> 'RAW_MATERIAL');

-- ---------------------------------------------------------------------------
-- Migración de lo vivo: bobina concreta → agregado.
--
-- Producción está vacía (reset de go-live, D-129), así que esto solo corre sobre `dev`,
-- `demo` y `ci`. Se hace igual y completo: una reserva de materia prima que quedara
-- apuntando a una bobina sería una promesa que ningún guardrail nuevo mira.
--
-- Alcance: las líneas cuyo producto es una cobertura **a medida** (D-127). Una venta de
-- bobina entera (RF-73) sigue reservando la bobina, y ahí apuntar al rollo es lo
-- correcto: lo que se vende es ese rollo.
-- ---------------------------------------------------------------------------

-- 1. Los agregados que hacen falta, derivados del producto (color) y de su receta
--    (espesor de entrada), que es exactamente de donde el código los deriva ahora.
INSERT INTO "raw_material_specs" ("id", "business_line_id", "color_id", "thickness_mm")
SELECT gen_random_uuid(), d."business_line_id", d."color_id", d."thickness_mm"
FROM (
  SELECT DISTINCT
    p."business_line_id",
    p."color_id",
    b."input_thickness_mm" AS "thickness_mm"
  FROM "products" p
  JOIN "product_boms" b ON b."product_id" = p."id" AND b."is_active"
  WHERE p."roofing_kind" = 'A_MEDIDA'
    AND (
      EXISTS (
        SELECT 1 FROM "sales_order_items" soi
        JOIN "reservations" r ON r."sales_order_item_id" = soi."id" AND r."item_type" = 'COIL'
        WHERE soi."product_id" = p."id"
      )
      OR EXISTS (
        SELECT 1 FROM "sales_order_items" soi
        WHERE soi."product_id" = p."id" AND soi."reserve_item_type" = 'COIL'
      )
      OR EXISTS (
        SELECT 1 FROM "quotation_items" qi
        WHERE qi."product_id" = p."id" AND qi."reserve_item_type" = 'COIL'
      )
    )
) d
ON CONFLICT DO NOTHING;

-- 2. Las reservas. Se convierten **todas** las de una línea a medida, en cualquier
--    estado: una `CONSUMIDA` o `LIBERADA` que siguiera diciendo "bobina" haría que el
--    historial contradiga al modelo, y el traslado al producto terminado (D-088) lee
--    esas coordenadas para decidir si la línea ya está respaldada.
UPDATE "reservations" r
SET "item_type" = 'RAW_MATERIAL', "item_id" = s."id"
FROM "sales_order_items" soi
JOIN "products" p     ON p."id" = soi."product_id"
JOIN "product_boms" b ON b."product_id" = p."id" AND b."is_active"
JOIN "raw_material_specs" s
  ON s."business_line_id" = p."business_line_id"
 AND COALESCE(s."color_id", '00000000-0000-0000-0000-000000000000'::uuid)
     = COALESCE(p."color_id", '00000000-0000-0000-0000-000000000000'::uuid)
 AND s."thickness_mm" = b."input_thickness_mm"
WHERE soi."id" = r."sales_order_item_id"
  AND r."item_type" = 'COIL'
  AND p."roofing_kind" = 'A_MEDIDA';

-- 3. Las coordenadas congeladas de la línea de pedido, que son las mismas con otro
--    nombre y las que lee el despacho.
UPDATE "sales_order_items" soi
SET "reserve_item_type" = 'RAW_MATERIAL', "reserve_item_id" = s."id"
FROM "products" p
JOIN "product_boms" b ON b."product_id" = p."id" AND b."is_active"
JOIN "raw_material_specs" s
  ON s."business_line_id" = p."business_line_id"
 AND COALESCE(s."color_id", '00000000-0000-0000-0000-000000000000'::uuid)
     = COALESCE(p."color_id", '00000000-0000-0000-0000-000000000000'::uuid)
 AND s."thickness_mm" = b."input_thickness_mm"
WHERE p."id" = soi."product_id"
  AND soi."reserve_item_type" = 'COIL'
  AND p."roofing_kind" = 'A_MEDIDA';

-- 4. Lo mismo en la cotización. Acá el cambio es más profundo que un renombre: hasta hoy
--    una cotización a medida guardaba `PRODUCT` + metros (la intención, sin materia prima
--    resuelta) o una bobina elegida a mano. Desde D-134 guarda el agregado y los **kilos
--    teóricos**, que es lo que el vendedor ve y lo que la confirmación va a reservar.
--    Las que quedaron apuntando a una bobina se convierten; las que guardaban `PRODUCT`
--    se dejan como están y se recalculan solas al editarse o confirmarse, porque el kilo
--    teórico depende de la geometría del SKU y no se puede derivar en SQL sin repetir acá
--    la aritmética de `kgPerMeter`.
UPDATE "quotation_items" qi
SET "reserve_item_type" = 'RAW_MATERIAL', "reserve_item_id" = s."id"
FROM "products" p
JOIN "product_boms" b ON b."product_id" = p."id" AND b."is_active"
JOIN "raw_material_specs" s
  ON s."business_line_id" = p."business_line_id"
 AND COALESCE(s."color_id", '00000000-0000-0000-0000-000000000000'::uuid)
     = COALESCE(p."color_id", '00000000-0000-0000-0000-000000000000'::uuid)
 AND s."thickness_mm" = b."input_thickness_mm"
WHERE p."id" = qi."product_id"
  AND qi."reserve_item_type" = 'COIL'
  AND p."roofing_kind" = 'A_MEDIDA';

-- El índice que sostiene la invariante del lado del agregado: sumar lo reservado vivo de
-- una spec es una sola pasada. El de `(item_type, item_id, status)` ya existe y cubre
-- esta consulta; este agrega el camino inverso, de la spec a sus bobinas compatibles.
CREATE INDEX "raw_material_specs_lookup_idx"
  ON "raw_material_specs"("business_line_id", "thickness_mm");
