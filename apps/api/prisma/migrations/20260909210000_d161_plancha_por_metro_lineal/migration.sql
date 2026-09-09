-- D-161: la plancha de catálogo se cotiza por metro lineal.
--
-- `unit_price_pen` sigue siendo el valor por plancha (la línea se cuenta y se factura en
-- `NIU`, y el kardex de una plancha está en planchas). Lo que se agrega es el número que el
-- vendedor negocia de verdad —el valor por metro— para poder mostrarlo y reabrirlo a editar
-- sin dividir y arrastrar el redondeo.
--
-- Aditiva y nullable a propósito: `NULL` significa "esta línea no se cotizó por metro con
-- largo fijo", que es el caso de todo lo anterior a esta decisión, de las líneas a medida
-- (que ya cotizan por metro en `unit_price_pen`) y de todo lo que se vende por unidad. Nada
-- se recalcula: las cotizaciones y los pedidos históricos quedan exactamente como están.

ALTER TABLE "quotation_items" ADD COLUMN "value_per_meter_pen" DECIMAL(18,4);
ALTER TABLE "sales_order_items" ADD COLUMN "value_per_meter_pen" DECIMAL(18,4);
