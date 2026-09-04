-- Fase 6 (D-082..D-091): producción de coberturas metálicas contra pedido y maestro de
-- colores. Escrita a mano y aplicada con `migrate deploy` (D-018).

-- ---------------------------------------------------------------------------
-- D-087 — el `kind` que separa las dos líneas de transformación
-- ---------------------------------------------------------------------------
CREATE TYPE "ProductionOrderKind" AS ENUM ('DRYWALL', 'ROOFING');
CREATE TYPE "ProductBomKind" AS ENUM ('DRYWALL', 'ROOFING');

-- ---------------------------------------------------------------------------
-- D-085 — maestro de colores
-- ---------------------------------------------------------------------------
CREATE TABLE "colors" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "hex_color" VARCHAR(7) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "colors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "colors_code_key" ON "colors"("code");

ALTER TABLE "products" ADD COLUMN "color_id" UUID;
ALTER TABLE "products" ADD CONSTRAINT "products_color_id_fkey" FOREIGN KEY ("color_id") REFERENCES "colors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "products_color_id_idx" ON "products"("color_id");

ALTER TABLE "coils" ADD COLUMN "color_id" UUID;
ALTER TABLE "coils" ADD CONSTRAINT "coils_color_id_fkey" FOREIGN KEY ("color_id") REFERENCES "colors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- El índice del filtro de la OP de coberturas (D-086): línea + estado + color, y el
-- espesor al final porque la tolerancia lo consulta por rango.
CREATE INDEX "coils_business_line_id_status_color_id_thickness_mm_idx" ON "coils"("business_line_id", "status", "color_id", "thickness_mm");

-- ---------------------------------------------------------------------------
-- D-087 — la receta gana `kind` y las columnas de drywall pasan a nullable
-- ---------------------------------------------------------------------------
ALTER TABLE "product_boms" ADD COLUMN "kind" "ProductBomKind" NOT NULL DEFAULT 'DRYWALL';
ALTER TABLE "product_boms" ALTER COLUMN "input_width_mm" DROP NOT NULL;
ALTER TABLE "product_boms" ALTER COLUMN "piece_length_mm" DROP NOT NULL;
ALTER TABLE "product_boms" ALTER COLUMN "kg_per_piece" DROP NOT NULL;

-- Las tres columnas que drywall necesita siguen siendo obligatorias **para drywall**: lo
-- que la migración relaja es el tipo de columna, no la regla. Un `CHECK` la sostiene en la
-- base, para que ninguna ruta futura pueda crear una receta de perfiles a medio llenar.
ALTER TABLE "product_boms" ADD CONSTRAINT "product_boms_drywall_completa"
  CHECK (
    "kind" <> 'DRYWALL'
    OR ("input_width_mm" IS NOT NULL AND "piece_length_mm" IS NOT NULL AND "kg_per_piece" IS NOT NULL)
  );

CREATE INDEX "product_boms_kind_finish_id_input_thickness_mm_idx" ON "product_boms"("kind", "finish_id", "input_thickness_mm");

-- ---------------------------------------------------------------------------
-- D-084 / D-087 / D-089 — la orden de producción
-- ---------------------------------------------------------------------------
ALTER TABLE "production_orders" ADD COLUMN "kind" "ProductionOrderKind" NOT NULL DEFAULT 'DRYWALL';
ALTER TABLE "production_orders" ADD COLUMN "consumed_kg" DECIMAL(12,3);
CREATE INDEX "production_orders_kind_status_idx" ON "production_orders"("kind", "status");

-- D-084: una OP de coberturas no existe sin la reserva del pedido que viene a cumplir
-- (RF-31). El `CHECK` lo garantiza en la base y no solo en el schema del endpoint.
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_roofing_contra_pedido"
  CHECK ("kind" <> 'ROOFING' OR "reservation_id" IS NOT NULL);

ALTER TABLE "production_reports" ADD COLUMN "meters_m" DECIMAL(16,3);

CREATE TABLE "production_order_items" (
    "id" UUID NOT NULL,
    "production_order_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "length_mm" DECIMAL(8,2) NOT NULL,
    "qty" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_order_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_order_items_production_order_id_line_number_key" ON "production_order_items"("production_order_id", "line_number");
CREATE INDEX "production_order_items_production_order_id_idx" ON "production_order_items"("production_order_id");
ALTER TABLE "production_order_items" ADD CONSTRAINT "production_order_items_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_order_items" ADD CONSTRAINT "production_order_items_qty_positiva" CHECK ("qty" > 0 AND "length_mm" > 0);

CREATE TABLE "production_report_pieces" (
    "id" UUID NOT NULL,
    "report_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "length_mm" DECIMAL(8,2) NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "production_report_pieces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "production_report_pieces_report_id_line_number_key" ON "production_report_pieces"("report_id", "line_number");
CREATE INDEX "production_report_pieces_report_id_idx" ON "production_report_pieces"("report_id");
ALTER TABLE "production_report_pieces" ADD CONSTRAINT "production_report_pieces_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "production_reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "production_report_pieces" ADD CONSTRAINT "production_report_pieces_qty_positiva" CHECK ("qty" > 0 AND "length_mm" > 0);

-- ---------------------------------------------------------------------------
-- D-083 — subítems de largo en la línea comercial
-- ---------------------------------------------------------------------------
CREATE TABLE "quotation_item_pieces" (
    "id" UUID NOT NULL,
    "quotation_item_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "length_mm" DECIMAL(8,2) NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "quotation_item_pieces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quotation_item_pieces_quotation_item_id_line_number_key" ON "quotation_item_pieces"("quotation_item_id", "line_number");
CREATE INDEX "quotation_item_pieces_quotation_item_id_idx" ON "quotation_item_pieces"("quotation_item_id");
ALTER TABLE "quotation_item_pieces" ADD CONSTRAINT "quotation_item_pieces_quotation_item_id_fkey" FOREIGN KEY ("quotation_item_id") REFERENCES "quotation_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quotation_item_pieces" ADD CONSTRAINT "quotation_item_pieces_qty_positiva" CHECK ("qty" > 0 AND "length_mm" > 0);

CREATE TABLE "sales_order_item_pieces" (
    "id" UUID NOT NULL,
    "sales_order_item_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "length_mm" DECIMAL(8,2) NOT NULL,
    "qty" INTEGER NOT NULL,

    CONSTRAINT "sales_order_item_pieces_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_order_item_pieces_sales_order_item_id_line_number_key" ON "sales_order_item_pieces"("sales_order_item_id", "line_number");
CREATE INDEX "sales_order_item_pieces_sales_order_item_id_idx" ON "sales_order_item_pieces"("sales_order_item_id");
ALTER TABLE "sales_order_item_pieces" ADD CONSTRAINT "sales_order_item_pieces_sales_order_item_id_fkey" FOREIGN KEY ("sales_order_item_id") REFERENCES "sales_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_order_item_pieces" ADD CONSTRAINT "sales_order_item_pieces_qty_positiva" CHECK ("qty" > 0 AND "length_mm" > 0);

-- ---------------------------------------------------------------------------
-- D-088 — la reserva deja de ser única por línea de pedido
-- ---------------------------------------------------------------------------
-- Una línea de cobertura sostiene a la vez la promesa de bobina que le queda y la de los
-- metros ya fabricados: la unicidad pasa a ser por (línea, ítem), que es lo que hace que
-- trasladar la promesa sea un upsert y no una decisión entre dos filas del mismo ítem.
DROP INDEX "reservations_sales_order_item_id_key";
CREATE UNIQUE INDEX "reservations_sales_order_item_id_item_type_item_id_key" ON "reservations"("sales_order_item_id", "item_type", "item_id");
CREATE INDEX "reservations_sales_order_item_id_status_idx" ON "reservations"("sales_order_item_id", "status");
