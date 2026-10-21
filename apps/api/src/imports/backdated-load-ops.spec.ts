import { Decimal } from '@ayr/shared';
import type { Sheets } from './backdated-load';
import { idempotencyKeyOf, planLoadOps } from './backdated-load-ops';
import { loadReference, takeFromPlan } from './backdated-load-runner';

/** cc64 (D-705): las operaciones del cargador, en orden y con clave estable. */
const empty = (): Sheets => ({
  purchases: [],
  sales: [],
  production: [],
  dispatches: [],
  collections: [],
  supplierPayments: [],
});

describe('planLoadOps (cc64)', () => {
  it('ordena por paso y, dentro de cada paso, por fecha; la venta va antes que su pedido', () => {
    const sheets = empty();
    sheets.purchases = [
      {
        'RUC PROVEEDOR': '20100000001',
        'SERIE-NÚMERO': 'F001-2',
        'FECHA DE RECEPCIÓN': '2026-10-16',
      },
      {
        'RUC PROVEEDOR': '20100000001',
        'SERIE-NÚMERO': 'F001-1',
        'FECHA DE RECEPCIÓN': '2026-10-14',
      },
      {
        'RUC PROVEEDOR': '20100000001',
        'SERIE-NÚMERO': 'f001-1 ',
        'FECHA DE RECEPCIÓN': '2026-10-14',
      },
    ];
    sheets.sales = [
      { 'F. EMISIÓN': '2026-10-15', 'SERIE - NÚMERO': 'F930-2', 'TIPO COMPROBANTE': 'BOLETA' },
      { 'F. EMISIÓN': '2026-10-14', 'SERIE - NÚMERO': 'F930-1', 'TIPO COMPROBANTE': 'FACTURA' },
      {
        'F. EMISIÓN': '2026-10-14',
        'SERIE - NÚMERO': 'FC01-1',
        'TIPO COMPROBANTE': 'NOTA DE CRÉDITO',
      },
    ];
    sheets.dispatches = [
      { 'SERIE - NÚMERO': 'F930-1', FECHA: '2026-10-15', 'CÓDIGO PRODUCTO': 'A', CANTIDAD: '1' },
      { 'SERIE - NÚMERO': 'F930-1', FECHA: '2026-10-15', 'CÓDIGO PRODUCTO': 'B', CANTIDAD: '2' },
      {
        'SERIE - NÚMERO': 'F930-1',
        FECHA: '2026-10-15',
        'CÓDIGO PRODUCTO': 'C',
        CANTIDAD: '1',
        MODALIDAD: 'ENTREGA',
        'DIRECCIÓN DESTINO': 'Av. 1',
        UBIGEO: '150101',
      },
    ];
    sheets.collections = [{ 'SERIE - NÚMERO': 'F930-1', FECHA: '2026-10-16', MONTO: '10' }];
    sheets.supplierPayments = [
      { 'RUC PROVEEDOR': '20100000001', 'SERIE-NÚMERO': 'F001-1', FECHA: '2026-10-15', MONTO: '5' },
    ];
    const { ops } = planLoadOps(sheets);
    expect(ops.map((o) => o.key)).toEqual([
      'compra|20100000001|F001-1',
      'compra|20100000001|F001-2',
      'venta|F930-1',
      'venta|F930-2',
      'pedido|F930-1',
      'pedido|F930-2',
      'despacho|F930-1|2026-10-15|1',
      'despacho|F930-1|2026-10-15|2',
      'comprobante|F930-1',
      'comprobante|F930-2',
      'cobro|F930-1|1',
      'pago|20100000001|F001-1|1',
    ]);
    // Las dos filas del mismo comprobante de compra (con mayúsculas y espacios distintos) son uno.
    const purchase = ops[0];
    expect(purchase?.step === 'purchases' && purchase.raws).toHaveLength(2);
    // Recojo y entrega el mismo día van en despachos distintos; el recojo junta sus dos filas.
    const pickup = ops[6];
    expect(pickup?.step === 'dispatches' && pickup.items).toHaveLength(2);
    const delivery = ops[7];
    expect(delivery?.step === 'dispatches' && delivery.mode).toBe('DELIVERY');
    const boleta = ops.find((o) => o.key === 'comprobante|F930-2');
    expect(boleta?.step === 'invoices' && boleta.docType).toBe('BOLETA');
  });

  it('los partes de drywall se cargan a mano y no son operaciones', () => {
    const sheets = empty();
    sheets.production = [
      {
        'SERIE - NÚMERO': 'F930-1',
        FECHA: '2026-10-15',
        'CÓDIGO PRODUCTO': 'PERFIL',
        CANTIDAD: '10',
      },
      { 'SERIE - NÚMERO': 'F930-1', FECHA: '2026-10-14', 'CÓDIGO PRODUCTO': 'PL', CANTIDAD: '3' },
      { 'SERIE - NÚMERO': 'F930-1', FECHA: '2026-10-13', 'CÓDIGO PRODUCTO': 'PL', CANTIDAD: '2' },
    ];
    const info = new Map([
      ['PERFIL', { drywall: true, needsLengths: false }],
      ['PL', { drywall: false, needsLengths: false }],
    ]);
    const { ops, manual } = planLoadOps(sheets, info);
    expect(manual).toEqual([
      { sheet: 'Producción', row: 2, reason: 'PERFIL es de drywall: el parte se carga a mano' },
    ]);
    // La clave sigue el orden del archivo (estable), el orden de ejecución es por fecha.
    expect(ops.map((o) => [o.key, o.date])).toEqual([
      ['parte|F930-1|PL|2', '2026-10-13'],
      ['parte|F930-1|PL|1', '2026-10-14'],
    ]);
  });

  it('la clave de idempotencia lleva el lote y cabe en 100 caracteres', () => {
    const a = idempotencyKeyOf('lote-1', 'venta|F930-1');
    expect(a).toMatch(/^carga-lote-1-[0-9a-f]{32}$/);
    expect(idempotencyKeyOf('lote-2', 'venta|F930-1')).not.toBe(a);
    expect(idempotencyKeyOf('lote-1', 'venta|F930-1', 'x')).not.toBe(a);
    expect(idempotencyKeyOf('x'.repeat(60), 'k').length).toBeLessThanOrEqual(100);
  });
});

describe('takeFromPlan (cc64)', () => {
  const plan = [
    { lineNumber: 1, lengthMm: '4500.00', qty: 2 },
    { lineNumber: 2, lengthMm: '3000.00', qty: 3 },
  ];

  it('toma piezas enteras de lo que queda, en el orden del plan', () => {
    expect(takeFromPlan(plan, [], new Decimal('12'))).toEqual([
      { lengthMm: '4500.00', qty: 2 },
      { lengthMm: '3000.00', qty: 1 },
    ]);
    // Con 1 pieza de 4,5 m ya reportada, quedan 1 × 4,5 y 3 × 3.
    const reported = [{ piecesDetail: [{ lengthMm: '4500.00', qty: 1 }] }];
    expect(takeFromPlan(plan, reported, new Decimal('7.5'))).toEqual([
      { lengthMm: '4500.00', qty: 1 },
      { lengthMm: '3000.00', qty: 1 },
    ]);
  });

  it('si los metros no son piezas enteras de lo que queda, no inventa', () => {
    expect(takeFromPlan(plan, [], new Decimal('5'))).toBeNull();
    expect(takeFromPlan(plan, [], new Decimal('100'))).toBeNull();
    expect(takeFromPlan(plan, [], new Decimal('0'))).toBeNull();
  });
});

describe('loadReference (cc64)', () => {
  it('lleva la marca del lote y queda recortada como la guarda el schema', () => {
    expect(loadReference('lote-123456789012345', '', 80)).toBe('CA lote-1234567');
    expect(loadReference('lote-1', ' op 55 ', 80)).toBe('CA lote-1 · op 55');
    expect(loadReference('lote-1', 'x'.repeat(200), 30)).toHaveLength(30);
  });
});
