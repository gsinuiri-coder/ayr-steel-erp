import { ForbiddenException } from '@nestjs/common';
import { PurchaseType, Role } from '@prisma/client';
import {
  blockedSummary,
  classifyReceivedEdit,
  fifoLotConsumption,
  type ItemFacts,
  type PurchaseFacts,
  type TargetFacts,
} from './purchase-received-edit';
import { ReceivedPurchaseEditService } from './purchase-received-edit.service';

/**
 * D-372 (cc14) — editar una compra recibida, versión 1. Las reglas viven en el clasificador puro:
 * acá se prueba cada grupo de campos y cada bloqueo con hechos armados a mano.
 */

const coilItem = (over: Partial<ItemFacts> = {}): ItemFacts => ({
  itemId: 'item-1',
  lineNumber: 1,
  productId: null,
  productLabel: null,
  description: 'BOBINA ROJO',
  unit: 'KGM',
  qty: '1000.000',
  unitPrice: '5.0000',
  finishId: 'fin-rojo',
  finishLabel: 'ROJO',
  widthMm: '1000.00',
  thicknessMm: '0.40',
  laterMovements: [],
  hasLiveIn: true,
  backsPromised: null,
  specPromised: null,
  balanceQty: '1000.000',
  reservedQty: '0.000',
  coilStatus: 'OPEN',
  mountedOrder: null,
  ownReservation: false,
  landedCost: false,
  sharedProduct: false,
  ...over,
});

const productItem = (over: Partial<ItemFacts> = {}): ItemFacts => ({
  ...coilItem(),
  productId: 'prod-1',
  productLabel: 'PERFIL-1',
  unit: 'NIU',
  qty: '100.000',
  unitPrice: '12.0000',
  finishId: null,
  finishLabel: null,
  widthMm: null,
  thicknessMm: null,
  coilStatus: null,
  balanceQty: '100.000',
  ...over,
});

const purchase = (over: Partial<PurchaseFacts> = {}): PurchaseFacts => ({
  purchaseId: 'p-1',
  type: PurchaseType.COIL,
  livePayments: 0,
  igvRateIssue: null,
  header: {
    supplierId: 'sup-1',
    supplierLabel: 'ACME (20123456789)',
    docType: 'FACTURA',
    series: 'F001',
    number: '123',
    issueDate: '2026-09-10',
    paymentTerms: 'CONTADO',
    creditDays: null,
    dueDate: null,
    notes: null,
  },
  items: [coilItem()],
  ...over,
});

const noTargets = (over: Partial<TargetFacts> = {}): TargetFacts => ({
  labels: new Map([
    ['sup-2', 'OTRO (20999999999)'],
    ['prod-2', 'PERFIL-2'],
    ['fin-azul', 'AZUL'],
  ]),
  productsWithLaterMovements: new Set(),
  invalidProducts: new Map(),
  invalidFinishes: new Map(),
  productNames: new Map([['prod-2', 'PERFIL DOS']]),
  ...over,
});

describe('D-372 (cc15) — lo que arrastra la cáscara y el producto', () => {
  it('pasar a contado borra los días de crédito y el vencimiento, y los muestra', () => {
    const plan = classifyReceivedEdit(
      purchase({
        header: {
          ...purchase().header,
          paymentTerms: 'CREDITO',
          creditDays: 30,
          dueDate: '2026-10-10',
        },
      }),
      { header: { paymentTerms: 'CONTADO' } },
      noTargets(),
    );
    expect(plan.changes.map((c) => [c.field, c.before, c.after])).toEqual([
      ['paymentTerms', 'CREDITO', 'CONTADO'],
      ['creditDays', '30', null],
      ['dueDate', '2026-10-10', null],
    ]);
  });

  it('cambiar la fecha de emisión de una compra al crédito recalcula el vencimiento', () => {
    const plan = classifyReceivedEdit(
      purchase({
        header: {
          ...purchase().header,
          paymentTerms: 'CREDITO',
          creditDays: 30,
          dueDate: '2026-10-10',
        },
      }),
      { header: { issueDate: '2026-09-15' } },
      noTargets(),
    );
    expect(plan.changes.find((c) => c.field === 'dueDate')).toMatchObject({
      before: '2026-10-10',
      after: '2026-10-15',
      path: 'IN_PLACE',
    });
  });

  it('pasar al crédito sin días se bloquea en la vista previa', () => {
    const plan = classifyReceivedEdit(
      purchase(),
      { header: { paymentTerms: 'CREDITO' } },
      noTargets(),
    );
    expect(plan.executable).toBe(false);
    expect(plan.changes.find((c) => c.field === 'creditDays')?.blockedReason).toContain(
      'necesita días de crédito',
    );
  });

  it('una compra al contado con días heredados no los muestra si no se toca la condición', () => {
    const plan = classifyReceivedEdit(
      purchase({ header: { ...purchase().header, creditDays: 15 } }),
      { header: { notes: 'x' } },
      noTargets(),
    );
    expect(plan.changes.map((c) => c.field)).toEqual(['notes']);
  });

  it('una corrección de costo anterior de esta compra se nombra como tal, no como otra compra', () => {
    const plan = classifyReceivedEdit(
      purchase({
        items: [
          coilItem({
            laterMovements: [
              { type: 'ADJUST', refType: 'OWN_COST_CORRECTION', operationDate: '2026-10-03' },
            ],
          }),
        ],
      }),
      { items: [{ itemId: 'item-1', qty: '990' }] },
      noTargets(),
    );
    expect(plan.changes[0]?.blockedReason).toContain('corrección de costo de esta compra');
  });

  it('cambiar de producto cambia también la descripción (decisión D)', () => {
    const plan = classifyReceivedEdit(
      purchase({
        type: PurchaseType.FINISHED_GOOD,
        items: [productItem({ description: 'PERFIL UNO' })],
      }),
      { items: [{ itemId: 'item-1', productId: 'prod-2' }] },
      noTargets(),
    );
    expect(plan.changes.map((c) => [c.field, c.before, c.after, c.path])).toEqual([
      ['productId', 'PERFIL-1', 'PERFIL-2', 'REVERSE_REENTRY'],
      ['description', 'PERFIL UNO', 'PERFIL DOS', 'IN_PLACE'],
    ]);
  });
});

describe('D-372 (cc15) — fifoLotConsumption (decisión A)', () => {
  const m = (id: number, type: 'IN' | 'OUT' | 'ADJUST', qty: string) => ({
    id: BigInt(id),
    type,
    qty,
  });

  it('las salidas consumen primero los lotes más antiguos', () => {
    // Lote 1: 100; lote 2 (el de la compra): 50. Salen 120: 100 del lote 1 y 20 del 2.
    const result = fifoLotConsumption(
      [m(1, 'IN', '100'), m(2, 'IN', '50'), m(3, 'OUT', '120'), m(4, 'ADJUST', '30')],
      2n,
    );
    expect(result.remaining.toFixed(3)).toBe('30.000');
    expect(result.consumers.map((c) => [c.movement.id, c.qty.toFixed(3)])).toEqual([
      [3n, '20.000'],
    ]);
  });

  it('un lote que nadie tocó queda entero; uno agotado, en cero', () => {
    expect(fifoLotConsumption([m(1, 'IN', '10'), m(2, 'IN', '5')], 2n).remaining.toFixed(0)).toBe(
      '5',
    );
    expect(
      fifoLotConsumption(
        [m(1, 'IN', '10'), m(2, 'OUT', '4'), m(3, 'OUT', '6')],
        1n,
      ).remaining.toFixed(0),
    ).toBe('0');
  });
});

describe('D-372 — classifyReceivedEdit', () => {
  describe('salvaguardas de la revisión', () => {
    it('sin ingreso de kardex vivo, precio y cantidad se bloquean; la especificación sola no', () => {
      const facts = purchase({ items: [coilItem({ hasLiveIn: false })] });
      const plan = classifyReceivedEdit(
        facts,
        { items: [{ itemId: 'item-1', unitPrice: '6', qty: '990' }] },
        noTargets(),
      );
      expect(plan.changes.every((c) => c.path === 'BLOCKED')).toBe(true);
      expect(plan.changes[0]?.blockedReason).toContain('ingreso de kardex vivo');
      const spec = classifyReceivedEdit(
        facts,
        { items: [{ itemId: 'item-1', widthMm: '1200' }] },
        noTargets(),
      );
      expect(spec.changes[0]?.path).toBe('IN_PLACE');
    });

    it('tasa de IGV no estándar: bloquea precio y cantidad, no la cáscara', () => {
      const plan = classifyReceivedEdit(
        purchase({ igvRateIssue: 'La compra no tiene una tasa de IGV estándar' }),
        { header: { notes: 'x' }, items: [{ itemId: 'item-1', unitPrice: '6' }] },
        noTargets(),
      );
      expect(plan.changes.find((c) => c.field === 'notes')?.path).toBe('IN_PLACE');
      expect(plan.changes.find((c) => c.field === 'unitPrice')?.blockedReason).toContain(
        'tasa de IGV',
      );
    });

    it('la misma línea dos veces en la edición: bloqueada', () => {
      const plan = classifyReceivedEdit(
        purchase(),
        {
          items: [
            { itemId: 'item-1', unitPrice: '6' },
            { itemId: 'item-1', unitPrice: '7' },
          ],
        },
        noTargets(),
      );
      expect(plan.executable).toBe(false);
      expect(plan.changes.at(-1)?.blockedReason).toContain('dos veces');
    });

    it('dos líneas que quedarían con el mismo producto: bloqueado', () => {
      const plan = classifyReceivedEdit(
        purchase({
          type: PurchaseType.FINISHED_GOOD,
          items: [
            productItem(),
            productItem({ itemId: 'item-2', lineNumber: 2, productId: 'prod-2' }),
          ],
        }),
        { items: [{ itemId: 'item-1', productId: 'prod-2' }] },
        noTargets(),
      );
      expect(plan.changes[0]?.blockedReason).toContain('mismo producto en dos líneas');
    });

    it('reserva (cc15b, punto 3): el precio pasa; la cantidad se mide contra el saldo final; la especificación sigue bloqueada', () => {
      const reserved = coilItem({ ownReservation: true, reservedQty: '1000.000' });
      const price = classifyReceivedEdit(
        purchase({ items: [reserved] }),
        { items: [{ itemId: 'item-1', unitPrice: '6' }] },
        noTargets(),
      );
      expect(price.changes[0]?.path).toBe('REVERSE_REENTRY');
      const qty = classifyReceivedEdit(
        purchase({ items: [reserved] }),
        { items: [{ itemId: 'item-1', qty: '990' }] },
        noTargets(),
      );
      expect(qty.changes[0]?.blockedReason).toContain(
        'quedarían 990.000 y hay 1000.000 reservados',
      );
      const spec = classifyReceivedEdit(
        purchase({ items: [reserved] }),
        { items: [{ itemId: 'item-1', widthMm: '1200' }] },
        noTargets(),
      );
      expect(spec.changes[0]?.blockedReason).toContain('reserva propia');
    });

    it('cambio de color o espesor de una bobina comprometida (punto 5): bloqueado con los pedidos', () => {
      const plan = classifyReceivedEdit(
        purchase({ items: [coilItem({ specPromised: 'PED-000009 (300.000 kg)' })] }),
        { items: [{ itemId: 'item-1', finishId: 'fin-azul' }] },
        noTargets(),
      );
      expect(plan.changes[0]?.blockedReason).toContain(
        'No se puede cambiar el color o el espesor porque esta bobina respalda material comprometido de PED-000009',
      );
    });
  });

  describe('cáscara', () => {
    it('serie, número, tipo, fecha, condiciones y observaciones se editan en la fila', () => {
      const plan = classifyReceivedEdit(
        purchase(),
        {
          header: {
            docType: 'BOLETA',
            series: 'F002',
            number: '124',
            issueDate: '2026-09-11',
            paymentTerms: 'CREDITO',
            creditDays: 30,
            notes: 'corregida',
          },
        },
        noTargets(),
      );
      expect(plan.executable).toBe(true);
      expect(plan.changes.map((c) => [c.field, c.group, c.path])).toEqual([
        ['docType', 'SHELL', 'IN_PLACE'],
        ['series', 'SHELL', 'IN_PLACE'],
        ['number', 'SHELL', 'IN_PLACE'],
        ['issueDate', 'SHELL', 'IN_PLACE'],
        ['paymentTerms', 'SHELL', 'IN_PLACE'],
        ['creditDays', 'SHELL', 'IN_PLACE'],
        ['notes', 'SHELL', 'IN_PLACE'],
        ['dueDate', 'SHELL', 'IN_PLACE'],
      ]);
    });

    it('un valor igual al actual no es un cambio', () => {
      const plan = classifyReceivedEdit(
        purchase(),
        {
          header: { series: 'F001', number: '123' },
          items: [{ itemId: 'item-1', unitPrice: '5' }],
        },
        noTargets(),
      );
      expect(plan.changes).toEqual([]);
      expect(plan.executable).toBe(false);
    });

    it('el proveedor se cambia sin pagos y se bloquea con pagos vigentes', () => {
      const free = classifyReceivedEdit(
        purchase(),
        { header: { supplierId: 'sup-2' } },
        noTargets(),
      );
      expect(free.changes[0]).toMatchObject({
        path: 'IN_PLACE',
        before: 'ACME (20123456789)',
        after: 'OTRO (20999999999)',
      });
      const paid = classifyReceivedEdit(
        purchase({ livePayments: 1 }),
        { header: { supplierId: 'sup-2' } },
        noTargets(),
      );
      expect(paid.changes[0]?.path).toBe('BLOCKED');
      expect(paid.changes[0]?.blockedReason).toContain('pagos vigentes');
      expect(paid.executable).toBe(false);
    });

    it('con pagos vigentes el resto de la cáscara sí se edita', () => {
      const plan = classifyReceivedEdit(
        purchase({ livePayments: 1 }),
        { header: { notes: 'ok' } },
        noTargets(),
      );
      expect(plan.executable).toBe(true);
    });
  });

  describe('costo (precio de la línea)', () => {
    it('sin movimientos posteriores: reversa y nuevo ingreso', () => {
      const plan = classifyReceivedEdit(
        purchase(),
        { items: [{ itemId: 'item-1', unitPrice: '5.5' }] },
        noTargets(),
      );
      expect(plan.changes).toEqual([
        expect.objectContaining({
          group: 'COST',
          field: 'unitPrice',
          lineNumber: 1,
          before: '5.0000',
          after: '5.5000',
          path: 'REVERSE_REENTRY',
          blockedReason: null,
        }),
      ]);
      expect(plan.executable).toBe(true);
    });

    it('con consumo posterior: ajuste proporcional (cc15), aunque haya reserva', () => {
      const plan = classifyReceivedEdit(
        purchase({
          items: [
            coilItem({
              ownReservation: true,
              laterMovements: [
                { type: 'OUT', refType: 'PRODUCTION', operationDate: '2026-09-15' },
                { type: 'OUT', refType: 'SCRAP', operationDate: '2026-09-16' },
              ],
            }),
          ],
        }),
        { items: [{ itemId: 'item-1', unitPrice: '5.5' }] },
        noTargets(),
      );
      expect(plan.changes[0]).toMatchObject({ path: 'COST_ADJUST', blockedReason: null });
      expect(plan.executable).toBe(true);
    });

    it('ajuste proporcional: lo bloquean pagos, landed cost, montada, sin ingreso vivo e IGV no estándar', () => {
      const consumedItem = (over: Partial<ItemFacts> = {}): ItemFacts =>
        coilItem({
          laterMovements: [{ type: 'OUT', refType: 'SCRAP', operationDate: '2026-09-16' }],
          ...over,
        });
      const price = { items: [{ itemId: 'item-1', unitPrice: '5.5' }] };
      const reasonOf = (facts: PurchaseFacts): string | null =>
        classifyReceivedEdit(facts, price, noTargets()).changes[0]?.blockedReason ?? null;
      expect(reasonOf(purchase({ livePayments: 1, items: [consumedItem()] }))).toContain('pagos');
      expect(reasonOf(purchase({ items: [consumedItem({ landedCost: true })] }))).toContain(
        'landed cost',
      );
      expect(
        reasonOf(purchase({ items: [consumedItem({ mountedOrder: 'OP-000001' })] })),
      ).toContain('montada');
      expect(reasonOf(purchase({ items: [consumedItem({ hasLiveIn: false })] }))).toContain(
        'ingreso de kardex vivo',
      );
      expect(
        reasonOf(purchase({ igvRateIssue: 'tasa de IGV rara', items: [consumedItem()] })),
      ).toContain('tasa de IGV');
    });

    it('con consumo, precio y cantidad juntos: la cantidad sigue bloqueada (decisión 7)', () => {
      const plan = classifyReceivedEdit(
        purchase({
          items: [
            coilItem({
              laterMovements: [{ type: 'OUT', refType: 'SCRAP', operationDate: '2026-09-16' }],
            }),
          ],
        }),
        { items: [{ itemId: 'item-1', unitPrice: '5.5', qty: '990' }] },
        noTargets(),
      );
      expect(plan.executable).toBe(false);
      expect(plan.changes.every((c) => c.path === 'BLOCKED')).toBe(true);
      expect(plan.changes[0]?.blockedReason).toContain('merma (SCRAP) el 2026-09-16');
    });

    it('solo otra compra posterior del mismo producto (punto 4): precio y cantidad pasan; el cambio de producto no', () => {
      const facts = purchase({
        type: PurchaseType.FINISHED_GOOD,
        items: [
          productItem({
            balanceQty: '150.000',
            laterMovements: [{ type: 'IN', refType: 'PURCHASE', operationDate: '2026-09-27' }],
          }),
        ],
      });
      const price = classifyReceivedEdit(
        facts,
        { items: [{ itemId: 'item-1', unitPrice: '13', qty: '90' }] },
        noTargets(),
      );
      expect(price.changes.map((c) => c.path)).toEqual(['REVERSE_REENTRY', 'REVERSE_REENTRY']);
      const product = classifyReceivedEdit(
        facts,
        { items: [{ itemId: 'item-1', productId: 'prod-2' }] },
        noTargets(),
      );
      expect(product.changes[0]?.blockedReason).toContain('otra compra (PURCHASE) el 2026-09-27');
    });

    it('otra compra posterior y además una salida: el precio va por ajuste, no por reemplazo', () => {
      const plan = classifyReceivedEdit(
        purchase({
          type: PurchaseType.FINISHED_GOOD,
          items: [
            productItem({
              laterMovements: [
                { type: 'IN', refType: 'PURCHASE', operationDate: '2026-09-27' },
                { type: 'OUT', refType: 'SALE', operationDate: '2026-09-28' },
              ],
            }),
          ],
        }),
        { items: [{ itemId: 'item-1', unitPrice: '13' }] },
        noTargets(),
      );
      expect(plan.changes[0]?.path).toBe('COST_ADJUST');
    });

    it('pagos vigentes bloquean el costo', () => {
      const plan = classifyReceivedEdit(
        purchase({ livePayments: 2 }),
        { items: [{ itemId: 'item-1', unitPrice: '5.5' }] },
        noTargets(),
      );
      expect(plan.changes[0]?.blockedReason).toContain('pagos vigentes');
    });
  });

  describe('kardex', () => {
    it('cantidad sin movimientos posteriores: reversa y nuevo ingreso', () => {
      const plan = classifyReceivedEdit(
        purchase(),
        { items: [{ itemId: 'item-1', qty: '980' }] },
        noTargets(),
      );
      expect(plan.changes[0]).toMatchObject({
        group: 'KARDEX',
        field: 'qty',
        before: '1000.000',
        after: '980.000',
        path: 'REVERSE_REENTRY',
      });
    });

    it('cantidad con movimientos posteriores: bloqueada con el detalle, sin la promesa de la próxima versión', () => {
      const plan = classifyReceivedEdit(
        purchase({
          items: [
            coilItem({
              laterMovements: [{ type: 'OUT', refType: 'SALE', operationDate: '2026-09-20' }],
            }),
          ],
        }),
        { items: [{ itemId: 'item-1', qty: '980' }] },
        noTargets(),
      );
      const reason = plan.changes[0]?.blockedReason ?? '';
      expect(reason).toContain('movimientos posteriores');
      expect(reason).toContain('venta (SALE) el 2026-09-20');
      expect(reason).not.toContain('próxima versión');
    });

    it('especificación de una bobina intacta: se corrige en la fila', () => {
      const plan = classifyReceivedEdit(
        purchase(),
        {
          items: [{ itemId: 'item-1', finishId: 'fin-azul', widthMm: '1200', thicknessMm: '0.5' }],
        },
        noTargets(),
      );
      expect(plan.changes.map((c) => [c.field, c.path, c.after])).toEqual([
        ['finishId', 'IN_PLACE', 'AZUL'],
        ['widthMm', 'IN_PLACE', '1200.00'],
        ['thicknessMm', 'IN_PLACE', '0.50'],
      ]);
    });

    it('especificación junto con la cantidad: va en la misma reversa', () => {
      const plan = classifyReceivedEdit(
        purchase(),
        { items: [{ itemId: 'item-1', qty: '990', widthMm: '1200' }] },
        noTargets(),
      );
      expect(plan.changes.every((c) => c.path === 'REVERSE_REENTRY')).toBe(true);
    });

    it('acabado inválido: bloqueado con el motivo', () => {
      const plan = classifyReceivedEdit(
        purchase(),
        { items: [{ itemId: 'item-1', finishId: 'fin-azul' }] },
        noTargets({ invalidFinishes: new Map([['fin-azul', 'El acabado está desactivado']]) }),
      );
      expect(plan.changes[0]?.blockedReason).toBe('El acabado está desactivado');
    });

    it('reserva propia de la bobina: bloquea cantidad y especificación', () => {
      const plan = classifyReceivedEdit(
        purchase({ items: [coilItem({ ownReservation: true })] }),
        { items: [{ itemId: 'item-1', widthMm: '1200' }] },
        noTargets(),
      );
      expect(plan.changes[0]?.blockedReason).toContain('reserva propia');
    });

    it('producto de una compra de producto terminado: reversa y nuevo ingreso', () => {
      const plan = classifyReceivedEdit(
        purchase({ type: PurchaseType.FINISHED_GOOD, items: [productItem()] }),
        { items: [{ itemId: 'item-1', productId: 'prod-2' }] },
        noTargets(),
      );
      expect(plan.changes[0]).toMatchObject({
        field: 'productId',
        before: 'PERFIL-1',
        after: 'PERFIL-2',
        path: 'REVERSE_REENTRY',
      });
    });

    it('producto nuevo con movimientos posteriores a la recepción, o inválido: bloqueado', () => {
      const later = classifyReceivedEdit(
        purchase({ type: PurchaseType.FINISHED_GOOD, items: [productItem()] }),
        { items: [{ itemId: 'item-1', productId: 'prod-2' }] },
        noTargets({ productsWithLaterMovements: new Set(['prod-2']) }),
      );
      expect(later.changes[0]?.blockedReason).toContain('producto nuevo ya tiene movimientos');
      const invalid = classifyReceivedEdit(
        purchase({ type: PurchaseType.FINISHED_GOOD, items: [productItem()] }),
        { items: [{ itemId: 'item-1', productId: 'prod-2' }] },
        noTargets({
          invalidProducts: new Map([['prod-2', 'El producto es de otra línea de negocio']]),
        }),
      );
      expect(invalid.changes[0]?.blockedReason).toBe('El producto es de otra línea de negocio');
    });

    it('cada grupo solo aplica a su tipo de compra', () => {
      const productOnCoil = classifyReceivedEdit(
        purchase(),
        { items: [{ itemId: 'item-1', productId: 'prod-2' }] },
        noTargets(),
      );
      expect(productOnCoil.changes[0]?.blockedReason).toContain('producto terminado');
      const specOnProduct = classifyReceivedEdit(
        purchase({ type: PurchaseType.FINISHED_GOOD, items: [productItem()] }),
        { items: [{ itemId: 'item-1', widthMm: '1200' }] },
        noTargets(),
      );
      expect(specOnProduct.changes[0]?.blockedReason).toContain('especificación de bobina');
      const service = classifyReceivedEdit(
        purchase({ type: PurchaseType.SERVICE, items: [productItem()] }),
        { items: [{ itemId: 'item-1', unitPrice: '13' }] },
        noTargets(),
      );
      expect(service.changes[0]?.blockedReason).toContain('solo se corrigen las líneas');
    });
  });

  describe('bloqueos de la bobina', () => {
    const cases: [string, Partial<ItemFacts>, string][] = [
      ['en corte tercerizado', { coilStatus: 'IN_THIRD_PARTY' }, 'corte tercerizado'],
      ['anulada', { coilStatus: 'CANCELLED' }, 'anulada'],
      ['montada en una OP', { mountedOrder: 'OP-000015' }, 'montada en OP-000015'],
      ['con landed cost', { landedCost: true }, 'landed cost'],
      ['con otra línea en el mismo producto', { sharedProduct: true }, 'mismo producto'],
    ];
    for (const [name, over, text] of cases) {
      it(`${name}: el precio y la cantidad se bloquean`, () => {
        const plan = classifyReceivedEdit(
          purchase({ items: [coilItem(over)] }),
          { items: [{ itemId: 'item-1', unitPrice: '6', qty: '990' }] },
          noTargets(),
        );
        expect(plan.changes).toHaveLength(2);
        for (const c of plan.changes) {
          expect(c.path).toBe('BLOCKED');
          expect(c.blockedReason).toContain(text);
        }
      });
    }
  });

  it('una línea que no es de la compra se rechaza', () => {
    const plan = classifyReceivedEdit(
      purchase(),
      { items: [{ itemId: 'otra', unitPrice: '6' }] },
      noTargets(),
    );
    expect(plan.changes[0]?.blockedReason).toBe('La línea no es de esta compra');
  });

  it('deshacer = volver a editar: tras una edición el ingreso nuevo es el único vivo, y se puede volver', () => {
    // La segunda edición ve los mismos hechos que la primera (la reversa y su original se
    // cancelan en `liveMovements`): el ítem sigue sin movimientos posteriores.
    const first = classifyReceivedEdit(
      purchase(),
      { items: [{ itemId: 'item-1', unitPrice: '5.5' }] },
      noTargets(),
    );
    const back = classifyReceivedEdit(
      purchase({ items: [coilItem({ unitPrice: '5.5000' })] }),
      { items: [{ itemId: 'item-1', unitPrice: '5' }] },
      noTargets(),
    );
    expect(first.executable && back.executable).toBe(true);
    expect(back.changes[0]).toMatchObject({ before: '5.5000', after: '5.0000' });
  });

  it('blockedSummary nombra la línea, el campo y el motivo', () => {
    const plan = classifyReceivedEdit(
      purchase({ livePayments: 1 }),
      { items: [{ itemId: 'item-1', unitPrice: '6' }] },
      noTargets(),
    );
    expect(blockedSummary(plan)).toContain(
      'Línea 1 · Precio unitario: La compra tiene pagos vigentes',
    );
  });
});

describe('D-372 — ReceivedPurchaseEditService', () => {
  const service = new ReceivedPurchaseEditService(
    { $transaction: jest.fn() } as never,
    { write: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const seller = {
    id: 'u-1',
    email: 'v@ayr.test',
    name: 'Vendedor',
    role: Role.SUPERVISOR_PLANTA,
    mustChangePassword: false,
    sessionId: 's',
  };

  it('un no administrador no ve la vista previa ni confirma', async () => {
    await expect(service.preview(seller, 'p-1', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.commit(seller, 'p-1', { reason: 'x' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
