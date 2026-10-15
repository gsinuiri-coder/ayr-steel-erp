import { auditEnumValueLabel } from './audit-values';

/**
 * Etiquetas legibles para las acciones de `audit_log` (D-218/RF-S2/M3). Lista cerrada de lo
 * que el código escribe hoy (censo por grep de `action: '...'` en `apps/api/src`); lo que no
 * esté acá cae en `humanizeAction`, que nunca deja una acción sin leer aunque sea menos
 * prolija — una acción nueva no debería poder hacer que el visor la muestre en blanco.
 */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  'auth.login': 'Inicio de sesión',
  'auth.login.failed': 'Intento de inicio de sesión fallido',
  'auth.logout': 'Cierre de sesión',
  'auth.password.changed': 'Cambio de contraseña propia',
  'catalog.create': 'Alta de producto',
  'catalog.update': 'Edición de producto',
  'catalog.product-delete': 'Producto borrado del catálogo (nunca se usó)',
  'catalog.price-list-import.confirm': 'Carga masiva de precios de lista confirmada',
  'catalog.price-list-import.revert': 'Carga masiva de precios de lista revertida',
  'coils.cancel': 'Anulación de bobina',
  'coils.restore': 'Bobina anulada restaurada',
  'coils.restore.undo': 'Restauración de bobina deshecha',
  'coils.close': 'Bobina terminada',
  'coils.auto-terminate-skipped': 'Bobina en 0 no terminada (anomalía)',
  'coils.auto-reopen-skipped': 'Reversa sin reabrir la bobina',
  'coils.cutting-cost': 'Costo de corte aplicado a bobina',
  'coils.film_open': 'Film de bobina abierto',
  'coils.film_reseal': 'Bobina vuelta a sellar',
  'coils.landed-cost': 'Costo de importación aplicado a bobina',
  'coils.open': 'Reapertura de bobina terminada',
  'coils.scrap': 'Merma registrada en bobina',
  'coils.scrap-cancel': 'Anulación de merma de bobina',
  'coils.split': 'Partido de bobina',
  'coils.split-revert': 'Reversa de partido de bobina',
  'coils.update': 'Edición de bobina',
  'colors.create': 'Alta de color',
  'colors.update': 'Edición de color',
  'customers.create': 'Alta de cliente',
  'cutting.invoice-linked': 'Factura de corte vinculada',
  'cutting.invoice-cancelled': 'Factura de corte anulada',
  'sales.quotation.line-at-cost': 'Línea vendida a costo',
  'sales.quotation.line-at-cost-removed': 'Línea a costo quitada',
  'customers.update': 'Edición de cliente',
  'cutting.cancel': 'Anulación de orden de corte',
  'cutting.receive': 'Recepción de corte',
  'cutting.receive-reverse': 'Reversa de recepción de corte',
  'cutting.send': 'Envío a corte tercerizado',
  'exchange-rates.manual-set': 'Tipo de cambio fijado a mano',
  'finishes.create': 'Alta de acabado',
  'finishes.update': 'Edición de acabado',
  'imports.initial-inventory': 'Carga de inventario inicial de bobinas',
  // cc52 (D-648): la salida con fecha atrasada que cambiaba de costo, aceptada por el administrador.
  'inventory.backdated-cost-accepted': 'Salida con fecha atrasada registrada con otro costo',
  // cc53 (D-649): recosteo del promedio por fecha.
  'inventory.recost': 'Recosteo por fecha',
  'inventory.recost-pending': 'Recosteo por fecha pendiente (supera el tope)',
  'inventory.recost-historic': 'Recosteo histórico cc53',
  'imports.initial-inventory-products': 'Carga de inventario inicial de productos',
  'invoicing.credit-note.create': 'Nota de crédito creada',
  'invoicing.credit-note.replacement': 'Comprobante de reemplazo registrado (NC 02)',
  'invoicing.credit-note.replacement-undone': 'Reemplazo deshecho al anular la NC 02',
  'invoicing.dispatch.create': 'Despacho creado',
  'invoicing.dispatch.reverse': 'Despacho revertido',
  'invoicing.dispatch.redate': 'Despacho re-fechado con la fecha de emisión corregida',
  'invoicing.dispatch.redate-rejected':
    'Re-fechado del despacho rechazado (dejaba el kardex negativo u otro bloqueo)',
  'invoicing.dispatch-note.create': 'Guía de remisión creada',
  'invoicing.document.correct': 'Comprobante corregido y reemitido',
  'invoicing.document.create': 'Comprobante creado',
  'invoicing.document.discard-draft': 'Borrador de comprobante descartado',
  'invoicing.document.issue': 'Comprobante emitido',
  'invoicing.document.move-to-order': 'Comprobante manual anulado traído a otro pedido',
  'invoicing.document.reactivate': 'Comprobante importado/manual reactivado (anulado por error)',
  'invoicing.document.reactivate-with-order-lines':
    'Comprobante manual reactivado con las líneas del pedido',
  'invoicing.document.register-manual': 'Comprobante manual registrado',
  'invoicing.document.retry': 'Reintento de envío de comprobante',
  'invoicing.document.update-issue-date': 'Fecha de emisión de comprobante manual corregida',
  'invoicing.document.void': 'Comprobante dado de baja',
  'invoicing.document.void-confirmed': 'Baja de comprobante confirmada por SUNAT',
  'invoicing.document.void-reconciled': 'Baja de comprobante reconciliada',
  'invoicing.document.void-rejected': 'Baja de comprobante rechazada',
  'invoicing.import.annul': 'Comprobante importado/manual anulado internamente',
  'invoicing.payment': 'Cobro registrado',
  'invoicing.payment-reverse': 'Reversa de cobro',
  'imports.purchases': 'Lote de compras importado',
  'imports.purchases.undo': 'Lote de compras deshecho',
  'invoicing.series.create': 'Alta de serie de comprobante',
  'invoicing.series.toggle': 'Serie de comprobante activada o desactivada',
  'invoicing.settings.update': 'Configuración de facturación actualizada',
  'pos.cash-session.close': 'Cierre de caja',
  'pos.cash-session.open': 'Apertura de caja',
  'pos.order.line-at-cost': 'Línea de mostrador vendida a costo',
  'pos.sale.create': 'Venta de mostrador',
  'pos.sale.void': 'Anulación de venta de mostrador',
  'pos.sale.void-start': 'Anulación de venta de mostrador iniciada',
  'pricing.update': 'Márgenes de precio actualizados',
  'production.bom.retire': 'Receta de drywall desactivada',
  'production.cancel': 'Anulación de orden de producción',
  'production.cancel-by-sales-order': 'Orden de producción anulada con su pedido',
  'production.close': 'Cierre de orden de producción',
  'production.consume': 'Consumo registrado en orden de producción',
  'production.create': 'Orden de producción creada',
  'production.plan-by-sales-order': 'Plan de la orden cambiado por la cantidad del pedido',
  'production.release': 'Liberación de orden de producción',
  'production.reopen': 'Reapertura de orden de producción',
  'production.report': 'Reporte de producción',
  'production.report-reverse': 'Reversa de reporte de producción',
  'production.roofing.cancel': 'Anulación de orden de coberturas',
  'production.roofing.close': 'Cierre de orden de coberturas',
  'production.roofing.create': 'Orden de coberturas creada',
  'production.roofing.create_batch': 'Lote de órdenes de coberturas creado',
  'production.roofing.drafts-commit': 'Borrador de reportes de coberturas confirmado',
  'production.roofing.mount': 'Bobina montada en producción de coberturas',
  'production.roofing.plan': 'Plan de corte de coberturas definido',
  'production.roofing.release': 'Liberación de orden de coberturas',
  'production.roofing.reopen': 'Reapertura de orden de coberturas',
  'production.roofing.report': 'Reporte de producción de coberturas',
  'production.roofing.report-reverse': 'Reversa de reporte de producción de coberturas',
  'purchases.cancel': 'Anulación de compra',
  'purchases.create': 'Compra registrada',
  'purchases.landed-cost': 'Costo de importación recibido de otra compra',
  'purchases.landed-cost-reverse': 'Costo de importación de otra compra revertido',
  'purchases.payment': 'Pago a proveedor registrado',
  'purchases.payment-reverse': 'Reversa de pago a proveedor',
  'purchases.receive': 'Recepción de compra',
  'purchases.update-document': 'Documento de compra editado',
  'purchases.xml-preview': 'XML de compra previsualizado',
  'sales.order.add-items': 'Líneas agregadas a pedido',
  'sales.order.cancel': 'Cancelación de pedido',
  'sales.order.confirm': 'Confirmación de pedido',
  'sales.order.customer': 'Cliente de pedido cambiado',
  'sales.order.document-moved-in': 'Comprobante traído desde otro pedido',
  'sales.order.document-moved-out': 'Comprobante llevado a otro pedido',
  'sales.order.item-price': 'Precio de línea de pedido editado',
  'sales.order.item-qty': 'Cantidad de línea de pedido editada',
  'sales.order.promised-delivery-date': 'Fecha de entrega prometida cambiada',
  'sales.quotation.cancel': 'Cancelación de cotización',
  'sales.quotation.create': 'Cotización creada',
  'sales.quotation.duplicate': 'Cotización duplicada',
  'sales.quotation.expire': 'Cotización vencida',
  'sales.quotation.recalculate-temporary': 'Reserva temporal de cotización recalculada',
  'sales.quotation.release-temporary': 'Reserva temporal de cotización liberada',
  'sales.quotation.reserve-temporary': 'Reserva temporal de cotización creada',
  'sales.quotation.update': 'Cotización editada',
  // cc52 (D-646): el documento de devolución de una NC de devolución.
  'sales.return.create': 'Devolución de mercadería registrada',
  'sales.return.reverse': 'Devolución de mercadería revertida',
  'sales.reservation.release': 'Liberación manual de reserva',
  'sales.reservation.restore': 'Reserva restaurada',
  'sales.settings.update': 'Configuración de ventas actualizada',
  'suppliers.create': 'Alta de proveedor',
  'suppliers.update': 'Edición de proveedor',
  'users.create': 'Alta de usuario',
  'users.deactivate': 'Desactivación de usuario',
  'users.password.reset': 'Restablecimiento de contraseña',
  'users.role.change': 'Cambio de rol de usuario',
  'users.update': 'Edición de usuario',
};

const CHANGELOG_ACTION_LABELS: Record<string, string> = {
  sales_price_change: 'Cambio de precio de línea',
  product_list_price_change: 'Cambio de precio de lista',
  fiscal_document_issue_date_change: 'Corrección de fecha de emisión',
};

/** Etiquetas del filtro "Tipo de entidad" del visor — cubre todo `AUDIT_ENTITY_TYPES`. */
export const AUDIT_ENTITY_TYPE_LABELS: Record<string, string> = {
  cash_sessions: 'Sesiones de caja',
  coil_splits: 'Partidos de bobina',
  coils: 'Bobinas',
  colors: 'Colores',
  customer_payments: 'Cobros',
  customers: 'Clientes',
  cutting_orders: 'Órdenes de corte',
  dispatches: 'Despachos',
  exchange_rates: 'Tipo de cambio',
  finishes: 'Acabados',
  fiscal_documents: 'Comprobantes',
  fiscal_series: 'Series de comprobante',
  // cc52: entidades nuevas del registro (D-648 y D-646).
  inventory_movements: 'Movimientos de kardex',
  invoicing_settings: 'Configuración de facturación',
  pos_sales: 'Ventas de mostrador',
  pricing_settings: 'Configuración de precios',
  product_boms: 'Recetas de producto',
  production_orders: 'Órdenes de producción',
  products: 'Productos',
  purchase_import_batches: 'Lotes de importación de compras',
  purchases: 'Compras',
  quotations: 'Cotizaciones',
  reservations: 'Reservas',
  sales_orders: 'Pedidos',
  sales_returns: 'Devoluciones de mercadería',
  sales_settings: 'Configuración de ventas',
  sessions: 'Sesiones',
  suppliers: 'Proveedores',
  users: 'Usuarios',
};

/** Nunca deja una acción sin leer: lo que no está en el mapa se separa por `.`/`-`/`_`. */
function humanizeAction(action: string): string {
  const words = action.split(/[._-]/).filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function auditActionLabel(action: string, source: string): string {
  if (source !== 'audit_log') return CHANGELOG_ACTION_LABELS[source] ?? humanizeAction(action);
  return AUDIT_ACTION_LABELS[action] ?? humanizeAction(action);
}

export function auditEntityTypeLabel(entityType: string): string {
  return AUDIT_ENTITY_TYPE_LABELS[entityType] ?? humanizeAction(entityType);
}

/**
 * Etiquetas de campo para el diff `before`/`after` del visor (D-225/ajustes UAT). D-218 descartó
 * a propósito un mapa por fuente para los ~105 `action` de `audit_log` (antes/después libre por
 * cada servicio de dominio) — eso sigue sin traducirse y cae en `humanizeFieldKey`. Lo que sí es
 * finito y vale la pena mapear son las claves de los tres changelogs dedicados que el visor ya
 * conoce por nombre (`sales_price_change`, `product_list_price_change`,
 * `fiscal_document_issue_date_change`) más `listPricePen`, que llega dentro de `audit_log` desde
 * `catalog.update` (D-217).
 */
const AUDIT_FIELD_LABELS: Record<string, string> = {
  lineNumber: 'Línea',
  unitValuePen: 'Precio unitario (sin IGV)',
  valuePerMeterPen: 'Precio por metro (sin IGV)',
  valuePen: 'Precio de lista',
  listPricePen: 'Precio de lista',
  origin: 'Origen',
  batchId: 'Lote',
  revertsBatchId: 'Revierte al lote',
  issueDate: 'Fecha de emisión',
  dueDate: 'Fecha de vencimiento',
  reason: 'Motivo',
  // cc50 (D-638): las claves de los registros nuevos (pagos, costo de importación, factura del
  // corte, lote y OP que sigue al pedido), para que el «Historial» se lea en castellano.
  document: 'Documento',
  amount: 'Monto',
  amountPen: 'Monto (S/)',
  currency: 'Moneda',
  method: 'Medio de pago',
  paymentId: 'Pago (id)',
  supplierId: 'Proveedor (id)',
  purchaseId: 'Compra (id)',
  serviceKind: 'Tipo de servicio',
  serviceDocument: 'Documento del servicio',
  servicePurchaseId: 'Compra del servicio (id)',
  subtotal: 'Subtotal (sin IGV)',
  coils: 'Bobinas',
  strips: 'Flejes',
  operationDate: 'Fecha de operación',
  importBatchId: 'Lote de importación',
  planMeters: 'Plan (m)',
  salesOrder: 'Pedido',
  salesOrderId: 'Pedido (id)',
  // cc51 (D-640): las claves cuyos valores ahora se traducen, para que el renglón entero se lea
  // en castellano.
  status: 'Estado',
  parentStatus: 'Estado de la bobina madre',
  orderStatus: 'Estado del pedido',
  statusBeforeAnnul: 'Estado antes de anular',
  type: 'Tipo',
  kind: 'Tipo',
  docType: 'Tipo de documento',
  role: 'Rol',
  unit: 'Unidad',
  outputUnit: 'Unidad producida',
  source: 'Origen del producto',
  roofingKind: 'Subtipo de cobertura',
  businessLine: 'Línea de negocio',
  film: 'Film',
  mode: 'Modo',
  outcome: 'Resultado',
  priceForm: 'Forma del precio',
  fiscalPath: 'Camino del comprobante',
  reserveItemType: 'Tipo de reserva',
  paymentTerms: 'Condición de pago',
  isActive: 'Activo',
  // cc51 (D-641): la línea vendida a costo.
  sku: 'SKU',
  costPen: 'Costo (S/, sin IGV)',
  atCostPricePen: 'Precio a costo (S/, con IGV)',
  priceUnit: 'Unidad del precio',
  atCostReason: 'A costo (motivo)',
  atCostNote: 'Motivo (texto)',
  code: 'Código',
  totalPen: 'Total (S/)',
  customerId: 'Cliente (id)',
  items: 'Líneas',
  active: 'Activo',
  // cc52 (D-645..D-648): nota de crédito, devolución y salida con fecha atrasada.
  salesReturn: 'Devolución',
  salesReturnId: 'Devolución (id)',
  creditNote: 'Nota de crédito',
  creditNoteId: 'Nota de crédito (id)',
  affects: 'Comprobante afectado',
  partial: 'Parcial',
  lines: 'Líneas',
  totalCost: 'Costo total (S/)',
  unitCost: 'Costo unitario (S/)',
  reserveQty: 'Cantidad en el kardex',
  reopenedCoils: 'Bobinas reabiertas',
  closedCoils: 'Bobinas terminadas',
  costUsed: 'Costo usado (S/)',
  costAtDate: 'Costo a esa fecha (S/)',
  laterCount: 'Movimientos posteriores',
  // cc53 (D-649): recosteo por fecha.
  recostedMovements: 'Movimientos recosteados',
  triggerMovementId: 'Movimiento que lo disparó',
  movementId: 'Movimiento de kardex',
  costBefore: 'Costo antes (S/)',
  costAfter: 'Costo después (S/)',
  costDelta: 'Diferencia de costo (S/)',
  adjustments: 'Ajustes de recosteo',
  rowsReplayed: 'Movimientos recalculados',
  maxRows: 'Tope de movimientos',
  recostItems: 'Ítems',
  item: 'Ítem',
  itemType: 'Tipo de ítem',
  itemId: 'Ítem (id)',
  qty: 'Cantidad',
  refType: 'Origen del movimiento',
  refId: 'Referencia (id)',
};

/** `"valuePerMeterPen"` → `"Value per meter pen"`: separa por mayúscula/`_` cuando la clave no
 *  está en `AUDIT_FIELD_LABELS`. Nunca deja una clave sin leer, aunque sea menos prolija. */
function humanizeFieldKey(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function auditFieldLabel(key: string): string {
  return AUDIT_FIELD_LABELS[key] ?? humanizeFieldKey(key);
}

/**
 * `null` cuando el valor no tiene una traducción conocida — el llamador decide el formato. Con la
 * acción, también los códigos que dependen de ella (cc51, D-640: `status`, `kind`, `reason`…).
 */
export function auditFieldValueLabel(key: string, value: unknown, action = ''): string | null {
  return auditEnumValueLabel(key, value, action, {
    actionLabel: (code) => AUDIT_ACTION_LABELS[code] ?? null,
  });
}

/**
 * `true` cuando el campo guarda un valor de venta sin IGV (D-162) que el catálogo muestra con
 * IGV (D-217): el precio de lista, tanto en su changelog dedicado (`valuePen`) como en el
 * `before`/`after` que `catalog.update` deja en `audit_log` (`listPricePen`).
 */
export function isPriceListValueField(source: string, action: string, key: string): boolean {
  if (source === 'product_list_price_change' && key === 'valuePen') return true;
  if (source === 'audit_log' && action === 'catalog.update' && key === 'listPricePen') {
    return true;
  }
  return false;
}

/**
 * cc48 (D-634): las opciones del filtro «Acción» del visor, ordenadas por rótulo: las de
 * `audit_log` y las de los tres changelogs (su `action` es el nombre de la fuente).
 */
export function auditActionOptions(): { value: string; label: string }[] {
  return [
    ...Object.entries(AUDIT_ACTION_LABELS).map(([value, label]) => ({ value, label })),
    ...Object.entries(CHANGELOG_ACTION_LABELS).map(([value, label]) => ({ value, label })),
  ].sort((a, b) => a.label.localeCompare(b.label, 'es'));
}
