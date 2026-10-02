import { ForbiddenException } from '@nestjs/common';
import { PurchaseType, Role } from '@prisma/client';
import {
  blockedSummary,
  classifyReceivedEdit,
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
  unit: 'KGM',
  qty: '1000.000',
  unitPrice: '5.0000',
  finishId: 'fin-rojo',
  finishLabel: 'ROJO',
  widthMm: '1000.00',
  thicknessMm: '0.40',
  laterMovements: [],
  hasLiveIn: true,
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
  ...over,
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

    it('reserva que la reversa dejaría sin cubrir: bloquea también el precio', () => {
      const plan = classifyReceivedEdit(
        purchase({ items: [coilItem({ ownReservation: true })] }),
        { items: [{ itemId: 'item-1', unitPrice: '6' }] },
        noTargets(),
      );
      expect(plan.changes[0]?.blockedReason).toContain('material reservado');
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

    it('con consumo posterior: bloqueado, «disponible en la próxima versión», con el detalle', () => {
      const plan = classifyReceivedEdit(
        purchase({
          items: [
            coilItem({
              laterMovements: [
                { refType: 'PRODUCTION', operationDate: '2026-09-15' },
                { refType: 'SCRAP', operationDate: '2026-09-16' },
              ],
            }),
          ],
        }),
        { items: [{ itemId: 'item-1', unitPrice: '5.5' }] },
        noTargets(),
      );
      expect(plan.changes[0]?.path).toBe('BLOCKED');
      expect(plan.changes[0]?.blockedReason).toContain('próxima versión');
      expect(plan.changes[0]?.blockedReason).toContain('producción (PRODUCTION) el 2026-09-15');
      expect(plan.changes[0]?.blockedReason).toContain('merma (SCRAP) el 2026-09-16');
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
          items: [coilItem({ laterMovements: [{ refType: 'SALE', operationDate: '2026-09-20' }] })],
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
