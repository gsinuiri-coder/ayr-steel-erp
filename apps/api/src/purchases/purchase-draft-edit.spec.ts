import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, PurchaseStatus } from '@prisma/client';
import {
  assertCanDeleteLine,
  assertDraftEditable,
  editedLineAmounts,
  impliedIgvRatePct,
  purchaseTotalsOf,
} from './purchase-draft-edit';
import { PurchasesService } from './purchases.service';

/**
 * D-371 — corregir o quitar líneas de una compra en borrador: solo sin kardex, sin pagos
 * vigentes y nunca la última línea; los totales se recalculan y la auditoría guarda antes y
 * después.
 */

const d = (v: string): Prisma.Decimal => new Prisma.Decimal(v);
const ACTOR = { id: 'u-1', role: 'ADMINISTRADOR' } as never;

describe('reglas de D-371', () => {
  it('solo el borrador sin pagos vigentes admite tocar sus líneas', () => {
    expect(() => {
      assertDraftEditable({ status: PurchaseStatus.DRAFT, livePayments: 0 });
    }).not.toThrow();
    expect(() => {
      assertDraftEditable({ status: PurchaseStatus.RECEIVED, livePayments: 0 });
    }).toThrow(/recibida/);
    expect(() => {
      assertDraftEditable({ status: PurchaseStatus.CANCELLED, livePayments: 0 });
    }).toThrow(/anulada/);
    expect(() => {
      assertDraftEditable({ status: PurchaseStatus.DRAFT, livePayments: 1 });
    }).toThrow(/pagos registrados/);
  });

  it('la última línea no se quita', () => {
    expect(() => {
      assertCanDeleteLine(1);
    }).toThrow(BadRequestException);
    expect(() => {
      assertCanDeleteLine(2);
    }).not.toThrow();
  });

  it('la tasa de IGV sale de los totales y se ajusta a 18 o 0; si no es estándar, no se edita', () => {
    expect(impliedIgvRatePct('3000.0000', '540.0000').toFixed(2)).toBe('18.00');
    // Redondeo a céntimo por línea o importes del papel (D-359): el ruido se absorbe.
    expect(impliedIgvRatePct('100.0001', '18.0000').toFixed(2)).toBe('18.00');
    expect(impliedIgvRatePct('1000.0000', '179.9500').toFixed(2)).toBe('18.00');
    expect(impliedIgvRatePct('500.0000', '0.0000').toFixed(2)).toBe('0.00');
    expect(impliedIgvRatePct('0', '0').toFixed(2)).toBe('0.00');
    // Una línea de céntimos (0.03 con IGV 0.01 = 33 %) no inventa una tasa.
    expect(() => impliedIgvRatePct('0.0300', '0.0100')).toThrow(/tasa de IGV estándar/);
    expect(() => impliedIgvRatePct('1000.0000', '100.0000')).toThrow(/10.00 %/);
  });

  it('la línea nueva usa la cuenta del alta y la cabecera suma sus líneas a su TC', () => {
    const line = editedLineAmounts('1000.000', '3.1234', '18');
    expect(line.subtotal.toFixed(4)).toBe('3123.4000');
    expect(line.igv.toFixed(4)).toBe('562.2120');
    expect(line.total.toFixed(4)).toBe('3685.6120');
    const totals = purchaseTotalsOf([line, { subtotal: '100.0000', igv: '18.0000' }], '3.7500');
    expect(totals.total.toFixed(4)).toBe('3803.6120');
    expect(totals.totalPen.toFixed(4)).toBe('14263.5450');
  });
});

interface ItemSeed {
  id: string;
  lineNumber: number;
  qty: string;
  unitPrice: string;
  subtotal: string;
  igv: string;
}

function item(s: ItemSeed) {
  return {
    ...s,
    description: `Línea ${String(s.lineNumber)}`,
    qty: d(s.qty),
    unitPrice: d(s.unitPrice),
    subtotal: d(s.subtotal),
    igv: d(s.igv),
    total: d(s.subtotal).plus(d(s.igv)),
  };
}

function build(opts: { status?: PurchaseStatus; payments?: number; items: ItemSeed[] }) {
  const status = opts.status ?? PurchaseStatus.DRAFT;
  const items = opts.items.map(item);
  const subtotal = items.reduce((acc, i) => acc.plus(i.subtotal), d('0'));
  const igv = items.reduce((acc, i) => acc.plus(i.igv), d('0'));
  const tx = {
    purchase: {
      updateMany: jest.fn().mockResolvedValue({ count: status === PurchaseStatus.DRAFT ? 1 : 0 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'pu-1',
        status,
        subtotal,
        igv,
        total: subtotal.plus(igv),
        exchangeRate: d('1.0000'),
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    supplierPayment: { count: jest.fn().mockResolvedValue(opts.payments ?? 0) },
    purchaseItem: {
      findMany: jest.fn().mockResolvedValue(items),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const service = new PurchasesService(
    prisma as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'pu-1' } as never);
  return { service, tx, audit };
}

const TWO_LINES: ItemSeed[] = [
  {
    id: 'it-1',
    lineNumber: 1,
    qty: '1000.000',
    unitPrice: '3.0000',
    subtotal: '3000.0000',
    igv: '540.0000',
  },
  {
    id: 'it-2',
    lineNumber: 2,
    qty: '10.000',
    unitPrice: '10.0000',
    subtotal: '100.0000',
    igv: '18.0000',
  },
];

describe('PurchasesService.updateItem / deleteItem (D-371)', () => {
  it('corrige cantidad y costo, recalcula la línea y la cabecera, y audita antes y después', async () => {
    const { service, tx, audit } = build({ items: TWO_LINES });
    await service.updateItem(ACTOR, 'pu-1', 'it-1', { qty: '900.000', unitPrice: '3.5000' });

    expect(tx.purchaseItem.update).toHaveBeenCalledWith({
      where: { id: 'it-1' },
      data: {
        qty: '900.000',
        unitPrice: '3.5000',
        subtotal: '3150.0000',
        igv: '567.0000',
        total: '3717.0000',
      },
    });
    expect(tx.purchase.update).toHaveBeenCalledWith({
      where: { id: 'pu-1' },
      data: { subtotal: '3250.0000', igv: '585.0000', total: '3835.0000', totalPen: '3835.0000' },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'purchases.update-item',
        before: expect.objectContaining({ qty: '1000.000', unitPrice: '3.0000' }),
        after: expect.objectContaining({ qty: '900.000', purchaseTotal: '3835.0000' }),
      }),
    );
  });

  it('guardar sin cambios no recalcula ni audita (no pisa el importe del papel, D-359)', async () => {
    const { service, tx, audit } = build({ items: TWO_LINES });
    await service.updateItem(ACTOR, 'pu-1', 'it-1', { qty: '1000', unitPrice: '3.0000' });
    expect(tx.purchaseItem.update).not.toHaveBeenCalled();
    expect(tx.purchase.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('una compra recibida no se toca: ni la línea ni la cabecera', async () => {
    const { service, tx } = build({ status: PurchaseStatus.RECEIVED, items: TWO_LINES });
    await expect(
      service.updateItem(ACTOR, 'pu-1', 'it-1', { qty: '1.000', unitPrice: '1.0000' }),
    ).rejects.toThrow(/recibida/);
    expect(tx.purchaseItem.update).not.toHaveBeenCalled();
    expect(tx.purchase.update).not.toHaveBeenCalled();
  });

  it('con un pago vigente no se edita', async () => {
    const { service, tx } = build({ payments: 1, items: TWO_LINES });
    await expect(service.deleteItem(ACTOR, 'pu-1', 'it-2')).rejects.toThrow(/pagos registrados/);
    expect(tx.purchaseItem.delete).not.toHaveBeenCalled();
  });

  it('una línea de otra compra es «no encontrada»', async () => {
    const { service } = build({ items: TWO_LINES });
    await expect(
      service.updateItem(ACTOR, 'pu-1', 'it-9', { qty: '1.000', unitPrice: '1.0000' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('quitar la primera renumera la siguiente y recalcula; la última no se quita', async () => {
    const { service, tx, audit } = build({ items: TWO_LINES });
    await service.deleteItem(ACTOR, 'pu-1', 'it-1');
    expect(tx.purchaseItem.delete).toHaveBeenCalledWith({ where: { id: 'it-1' } });
    expect(tx.purchaseItem.update).toHaveBeenCalledWith({
      where: { id: 'it-2' },
      data: { lineNumber: 1 },
    });
    expect(tx.purchase.update).toHaveBeenCalledWith({
      where: { id: 'pu-1' },
      data: { subtotal: '100.0000', igv: '18.0000', total: '118.0000', totalPen: '118.0000' },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'purchases.delete-item' }),
    );

    const single = build({ items: [TWO_LINES[0]!] });
    await expect(single.service.deleteItem(ACTOR, 'pu-1', 'it-1')).rejects.toThrow(/única línea/);
    expect(single.tx.purchaseItem.delete).not.toHaveBeenCalled();
  });
});

describe('PurchasesService.receive frente a D-371', () => {
  it('relee las líneas después del claim: recibe con la corrección confirmada, no con la foto vieja', async () => {
    const stale = {
      id: 'it-1',
      lineNumber: 1,
      qty: d('1000.000'),
      unitPrice: d('3.0000'),
      subtotal: d('3000.0000'),
      finishId: 'fin-1',
      colorId: null,
      widthMm: d('1200.00'),
      thicknessMm: d('0.30'),
      coilStatus: null,
      externalCode: null,
    };
    const fresh = { ...stale, qty: d('950.000'), subtotal: d('2850.0000') };
    const purchase = {
      id: 'pu-1',
      type: 'COIL',
      status: PurchaseStatus.DRAFT,
      businessLineId: 'bl-1',
      supplierId: 'sup-1',
      currency: 'PEN',
      exchangeRate: d('1.0000'),
      items: [stale],
    };
    const tx = {
      purchase: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      purchaseItem: { findMany: jest.fn().mockResolvedValue([fresh]) },
    };
    const coils = { create: jest.fn().mockResolvedValue({ id: 'coil-1' }) };
    const prisma = {
      purchase: { findUnique: jest.fn().mockResolvedValue(purchase) },
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const service = new PurchasesService(
      prisma as never,
      { write: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      coils as never,
      {} as never,
      {} as never,
      { resolve: jest.fn().mockReturnValue('2026-10-01') } as never,
    );
    const internals = service as unknown as Record<string, jest.Mock>;
    internals.applyLandedCost = jest.fn().mockResolvedValue(null);
    internals.applyCuttingOrderCost = jest.fn().mockResolvedValue(null);
    jest.spyOn(service, 'findOne').mockResolvedValue({ id: 'pu-1' } as never);

    await service.receive(ACTOR, 'pu-1');

    expect(coils.create).toHaveBeenCalledTimes(1);
    expect(coils.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ weightKg: '950.000', totalCost: '2850.0000' }),
    );
  });
});
