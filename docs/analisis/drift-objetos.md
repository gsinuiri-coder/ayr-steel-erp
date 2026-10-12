# Objetos de base de `production` contra las migraciones (cc46, D-610, D-611)

`pnpm check:drift:objetos` compara lo que `prisma migrate diff` (`check:drift`, D-593) no ve: CHECK
y exclusión, triggers, funciones, índices parciales o de expresión y vistas. La referencia es una
base vacía con todas las migraciones en un `postgres:<major>-alpine` descartable de la misma versión
mayor que `production`; de los dos lados se lee solo el catálogo, en una transacción `READ ONLY`.
Cómo correrlo y qué no cubre: encabezado de `scripts/check-drift-objetos.mjs`.

## Corrida del 2026-10-11 (cc46)

Postgres 18 en los dos lados. Comparación estricta: una diferencia de solo mayúsculas, comillas o
espacios se habría marcado cosmética; un trigger deshabilitado, una CHECK `NOT VALID` o un índice
inválido, real.

| Clase                            | Migraciones | `production` | Diferencias |
| -------------------------------- | ----------: | -----------: | ----------- |
| CHECK y exclusión                |          46 |           46 | ninguna     |
| Triggers                         |           7 |            7 | ninguna     |
| Funciones                        |           6 |            6 | ninguna     |
| Índices parciales o de expresión |           9 |            9 | ninguna     |
| Vistas                           |           0 |            0 | ninguna     |

**Clasificación:** ninguna diferencia REAL, esperada ni cosmética. No hay migración que proponer.

## Los objetos comparados

Nombres de esquema (no datos), `tabla.objeto`:

**CHECK y exclusión (46)**

- cash_sessions.cash_sessions_arqueo_ck
- cash_sessions.cash_sessions_counted_ck
- cash_sessions.cash_sessions_difference_reason_ck
- cash_sessions.cash_sessions_open_slot_ck
- cash_sessions.cash_sessions_opening_ck
- coil_film_events.coil_film_events_type_source_coherent
- customer_payments.customer_payments_amount_ck
- dispatch_items.dispatch_items_qty_ck
- dispatch_items.dispatch_items_reserve_qty_ck
- dispatches.dispatches_transport_ck
- dispatches.dispatches_weight_ck
- finishes.finishes_color_by_kind
- fiscal_document_items.fiscal_document_items_qty_ck
- fiscal_documents.fiscal_documents_amounts_ck
- fiscal_documents.fiscal_documents_annul_shape_ck
- fiscal_documents.fiscal_documents_annulled_origin_ck
- fiscal_documents.fiscal_documents_annulled_trace_ck
- fiscal_documents.fiscal_documents_archive_ck
- fiscal_documents.fiscal_documents_credit_note_ck
- fiscal_documents.fiscal_documents_number_ck
- fiscal_documents.fiscal_documents_shape_ck
- inventory_balances.inventory_balances_item_type_ck
- inventory_movements.inventory_movements_item_type_ck
- inventory_movements.inventory_movements_qty_positive
- pos_sales.pos_sales_total_ck
- pos_sales.pos_sales_void_ck
- product_boms.product_boms_drywall_only_ck
- product_boms.product_boms_none_active_ck
- production_order_items.production_order_items_qty_positiva
- production_orders.production_orders_roofing_contra_pedido_o_a_stock
- production_report_drafts.production_report_drafts_meters_check
- production_report_drafts.production_report_drafts_pieces_count_check
- production_report_pieces.production_report_pieces_qty_positiva
- products.products_merged_into_inactive_chk
- products.products_roofing_kind_unit_check
- quotation_item_pieces.quotation_item_pieces_qty_positiva
- quotation_items.quotation_items_pieces_hint_check
- quotation_reservations.quotation_reservations_ended_ck
- quotation_reservations.quotation_reservations_qty_positive_ck
- reservations.reservations_shortfall_qty_check
- sales_order_item_pieces.sales_order_item_pieces_qty_positiva
- sales_order_items.sales_order_items_pieces_hint_check
- sales_price_changes.sales_price_changes_holder_ck
- sales_settings.sales_settings_business_days_ck
- sales_settings.sales_settings_singleton_ck
- supplier_payments.supplier_payments_amount_positive

**Triggers (7)**

- audit_log.audit_log_no_update_delete
- coil_film_events.coil_film_events_no_update_delete
- coil_film_events.coil_film_events_sync
- coils.coils_color_from_finish
- finishes.finishes_color_to_items
- inventory_movements.inventory_movements_no_update_delete
- purchase_items.purchase_items_color_from_finish

**Funciones (6)**

- audit_log_immutable()
- coil_film_events_immutable()
- coil_film_events_sync()
- color_from_finish()
- finish_color_to_items()
- inventory_movements_immutable()

**Índices parciales o de expresión (9)**

- colors.colors_name_lower_key
- customers.customers_needs_review_idx
- fiscal_documents.fiscal_documents_number_active_key
- fiscal_series.fiscal_series_active_affected_key
- fiscal_series.fiscal_series_active_key
- invoicing_settings.invoicing_settings_singleton
- purchases.purchases_supplier_document_live_key
- raw_material_specs.raw_material_specs_key
- suppliers.suppliers_needs_review_idx

**Vistas (0):** ninguna.
