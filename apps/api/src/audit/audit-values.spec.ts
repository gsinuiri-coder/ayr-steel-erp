import { auditDetailText, auditFieldValueLabel, auditValueText } from '@ayr/shared';

/**
 * cc51 (D-640): los códigos en inglés del detalle de la auditoría se leen en castellano. La tabla es
 * el inventario de lo que el código escribe hoy en `before`/`after` (clave, una acción que la usa y
 * todos sus valores posibles): ninguno puede quedar sin traducir.
 */
const INVENTORY: readonly (readonly [key: string, action: string, values: readonly string[]])[] = [
  ['status', 'coils.cancel', ['OPEN', 'CLOSED', 'CANCELLED', 'IN_THIRD_PARTY']],
  ['status', 'coils.split-revert', ['ACTIVE', 'REVERTED']],
  ['parentStatus', 'coils.split-revert', ['OPEN', 'CLOSED', 'CANCELLED', 'IN_THIRD_PARTY']],
  ['status', 'cutting.cancel', ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED']],
  ['status', 'cutting.receive-reverse', ['SENT', 'RECEIVED', 'CANCELLED']],
  ['status', 'purchases.cancel', ['DRAFT', 'RECEIVED', 'CANCELLED']],
  ['status', 'production.close', ['DRAFT', 'IN_PROGRESS', 'CLOSED', 'CANCELLED']],
  ['status', 'production.roofing.cancel', ['DRAFT', 'IN_PROGRESS', 'CLOSED', 'CANCELLED']],
  ['status', 'production.cancel-by-sales-order', ['DRAFT', 'IN_PROGRESS', 'CLOSED', 'CANCELLED']],
  ['status', 'production.report-reverse', ['ACTIVE', 'REVERTED']],
  ['status', 'production.roofing.report-reverse', ['ACTIVE', 'REVERTED']],
  ['status', 'sales.quotation.cancel', ['DRAFT', 'EMITTED', 'CONFIRMED', 'EXPIRED', 'CANCELLED']],
  [
    'status',
    'sales.quotation.recalculate-temporary',
    ['ACTIVE', 'RELEASED', 'EXPIRED', 'CONVERTED'],
  ],
  [
    'status',
    'sales.order.cancel',
    ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'],
  ],
  ['status', 'sales.reservation.release', ['ACTIVE', 'CONSUMED', 'RELEASED']],
  [
    'status',
    'invoicing.document.void',
    ['DRAFT', 'ISSUED', 'ACCEPTED', 'REJECTED', 'SEND_ERROR', 'VOID_PENDING', 'VOIDED', 'ANNULLED'],
  ],
  ['status', 'invoicing.import.annul', ['ACCEPTED', 'ANNULLED']],
  ['statusBeforeAnnul', 'invoicing.document.reactivate', ['ACCEPTED', 'REJECTED']],
  ['status', 'invoicing.dispatch.reverse', ['ISSUED', 'REVERSED']],
  [
    'orderStatus',
    'invoicing.dispatch.create',
    ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'],
  ],
  ['status', 'pos.cash-session.close', ['OPEN', 'CLOSED']],
  ['status', 'pos.sale.void', ['ACTIVE', 'VOIDING', 'VOIDED']],
  ['origin', 'invoicing.document.register-manual', ['ISSUED_HERE', 'MANUAL', 'IMPORTED']],
  ['origin', 'product_list_price_change', ['INLINE', 'IMPORT']],
  ['origin', 'coils.open', ['production.roofing.mount']],
  ['outcome', 'invoicing.document.accepted', ['ACCEPTED', 'REJECTED', 'ERROR', 'PENDING']],
  [
    'method',
    'purchases.payment',
    ['CASH', 'TRANSFER', 'CHECK', 'DEPOSIT', 'CARD', 'WALLET', 'OTHER'],
  ],
  ['currency', 'purchases.payment', ['PEN', 'USD']],
  ['serviceKind', 'purchases.landed-cost', ['CUTTING', 'FREIGHT', 'CUSTOMS', 'INSURANCE', 'OTHER']],
  ['type', 'purchases.create', ['COIL', 'FINISHED_GOOD', 'SERVICE', 'EXPENSE']],
  ['docType', 'customers.create', ['DNI', 'RUC', 'CE']],
  ['docType', 'suppliers.update', ['DNI', 'RUC', 'CE']],
  [
    'docType',
    'invoicing.document.create',
    ['FACTURA', 'BOLETA', 'NOTA_CREDITO', 'GUIA_REMISION_REMITENTE'],
  ],
  ['docType', 'pos.sale.create', ['FACTURA', 'BOLETA']],
  ['role', 'users.role.change', ['ADMINISTRADOR', 'SUPERVISOR_PLANTA', 'VENDEDOR']],
  ['unit', 'catalog.update', ['KGM', 'NIU', 'MTR', 'TNE', 'ZZ', 'BX']],
  ['outputUnit', 'production.roofing.report', ['MTR', 'NIU']],
  ['source', 'catalog.create', ['MANUFACTURED', 'PURCHASED']],
  ['roofingKind', 'catalog.update', ['PLANCHA', 'A_MEDIDA', 'ACCESORIO']],
  ['kind', 'finishes.update', ['NATURAL', 'PREPINTADO', 'GALVANIZADO']],
  ['kind', 'production.roofing.create', ['DRYWALL', 'ROOFING']],
  ['kind', 'production.bom.retire', ['DRYWALL', 'ROOFING']],
  [
    'businessLine',
    'finishes.create',
    ['drywall', 'metallic-roofing', 'roofing', 'trading', 'services'],
  ],
  ['film', 'coils.film_open', ['SEALED', 'OPENED']],
  ['mode', 'coils.restore', ['EN_SU_FECHA', 'A_HOY', 'BLOQUEADA']],
  ['reason', 'coils.auto-terminate-skipped', ['MOUNTED', 'RESERVED', 'NEGATIVE']],
  ['reason', 'coils.auto-reopen-skipped', ['NOT_CLOSED', 'OTHER_CAUSE']],
  [
    'reason',
    'invoicing.credit-note.create',
    [
      'ANULACION_OPERACION',
      'ANULACION_ERROR_RUC',
      'CORRECCION_DESCRIPCION',
      'DESCUENTO_GLOBAL',
      'DESCUENTO_ITEM',
      'DEVOLUCION_TOTAL',
      'DEVOLUCION_ITEM',
      'OTROS_AJUSTES',
    ],
  ],
  [
    'reason',
    'production.roofing.report-tolerance-override',
    ['LIGHTER_COIL', 'HEAVIER_COIL', 'OTHER'],
  ],
  [
    'reason',
    'production.drywall.report-tolerance-override',
    ['LIGHTER_STRIP', 'HEAVIER_STRIP', 'STALE_PIECE_WEIGHT', 'OTHER'],
  ],
  [
    'priceForm',
    'sales.order.item-price',
    ['IMPORTE_DE_LINEA', 'PRECIO_CON_IGV', 'VALOR_POR_METRO', 'VALOR_UNITARIO'],
  ],
  ['fiscalPath', 'pos.sale.void', ['VOID', 'CREDIT_NOTE', 'NONE', 'DONE']],
  ['reserveItemType', 'sales.order.item-coil', ['PRODUCT', 'COIL', 'RAW_MATERIAL']],
];

const event = (action: string, after: Record<string, unknown>) => ({
  source: 'audit_log',
  action,
  before: null,
  after,
});

describe('cc51 (D-640) — cada código del inventario tiene su traducción', () => {
  it.each(INVENTORY.flatMap(([key, action, values]) => values.map((v) => [key, action, v])))(
    '%s de %s: %s',
    (key, action, value) => {
      const label = auditFieldValueLabel(key, value, action);
      expect(label).not.toBeNull();
    },
  );
});

describe('cc51 (D-640) — la misma clave según la acción', () => {
  it('ANULADA o ANULADO según el documento', () => {
    expect(auditFieldValueLabel('status', 'CANCELLED', 'coils.cancel')).toBe('Anulada');
    expect(auditFieldValueLabel('status', 'CANCELLED', 'sales.order.cancel')).toBe('Anulado');
    expect(auditFieldValueLabel('status', 'CLOSED', 'pos.cash-session.close')).toBe('Cerrada');
  });

  it('los de cc50 que quedaron en inglés: el pago y el flete', () => {
    expect(auditFieldValueLabel('method', 'TRANSFER', 'purchases.payment')).toBe('Transferencia');
    expect(auditFieldValueLabel('currency', 'PEN', 'purchases.payment')).toBe('Soles (PEN)');
    expect(auditFieldValueLabel('serviceKind', 'FREIGHT', 'purchases.landed-cost')).toBe('Flete');
  });

  it('el motivo libre nunca se toca; el código del motivo, sí', () => {
    expect(auditFieldValueLabel('reason', 'OTHER', 'purchases.cancel')).toBeNull();
    expect(auditFieldValueLabel('reason', 'Factura duplicada', 'purchases.cancel')).toBeNull();
    expect(
      auditFieldValueLabel('reason', 'DESCUENTO_ITEM', 'invoicing.credit-note.create'),
    ).not.toBeNull();
  });

  it('un estado de una acción que no se conoce sale tal cual', () => {
    expect(auditFieldValueLabel('status', 'OPEN', 'algo.nuevo')).toBeNull();
    expect(auditFieldValueLabel('document', 'F001-123', 'purchases.payment')).toBeNull();
  });

  it('una clave o un valor que coincide con algo del objeto no es un rótulo', () => {
    expect(auditFieldValueLabel('constructor', 'x', 'coils.close')).toBeNull();
    expect(auditFieldValueLabel('status', 'constructor', 'coils.close')).toBeNull();
    expect(
      auditValueText(event('purchases.update-received', {}), 'changes', [{ value: 'toString' }]),
    ).toBe('[{"value":"toString"}]');
  });

  it('sí y no', () => {
    expect(auditFieldValueLabel('isActive', true, 'catalog.update')).toBe('Sí');
    expect(auditFieldValueLabel('isActive', false, 'catalog.update')).toBe('No');
  });

  it('el origen que es otra acción se lee con su rótulo', () => {
    expect(auditFieldValueLabel('origin', 'production.roofing.mount', 'coils.open')).toBe(
      'Bobina montada en producción de coberturas',
    );
    expect(auditFieldValueLabel('origin', 'otra.cosa', 'coils.open')).toBeNull();
  });
});

describe('cc51 (D-640) — lo anidado, dentro del JSON', () => {
  it('el ajuste de un cierre y la causa de una terminación', () => {
    expect(
      auditValueText(event('coils.close', {}), 'adjustment', { kind: 'SHORTAGE', kg: '1.000' }),
    ).toBe('{"kind":"Faltante","kg":"1.000"}');
    expect(
      auditValueText(event('coils.close', {}), 'autoTerminated', {
        kind: 'PRODUCTION_ORDER_CLOSE',
        refType: 'PRODUCTION',
      }),
    ).toBe('{"kind":"Cierre de OP","refType":"Producción"}');
  });

  it('las líneas de un comprobante y los cambios de una compra recibida', () => {
    expect(
      auditDetailText(
        event('purchases.update-received', {
          changes: [{ path: 'IN_PLACE', value: 'CREDITO', imputed: true }],
        }),
      ),
    ).toBe('Changes: [{"path":"Se edita","value":"Crédito","imputed":"Sí"}]');
    expect(
      auditValueText(event('invoicing.document.move-to-order', {}), 'lines', [
        { unit: 'KGM', added: false },
      ]),
    ).toBe('[{"unit":"Kilogramo (KGM)","added":"No"}]');
  });
});
