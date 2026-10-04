import { FinishKind, Prisma } from '@prisma/client';
import { Role } from '@ayr/shared';
import { QuotationsService } from './quotations.service';

/**
 * D-385 (B): la bobina que sugirió el importador es solo una sugerencia. En la cotización, antes
 * de confirmar, se quita (la línea queda «sin bobina asignada») o se cambia por otra candidata:
 * mismo color que el papel, espesor dentro de la tolerancia, saldo ≥ los kilos del papel.
 */

jest.mock('../production/production-assignments', () => ({
  findLiveStripAssignments: jest.fn().mockResolvedValue([]),
}));
jest.mock('./reserved-ledger', () => ({
  reservedByItem: jest.fn().mockResolvedValue(new Map()),
  liveTemporaryWhere: () => ({}),
}));

const D = (v: string) => new Prisma.Decimal(v);
const ACTOR = { id: 'u-1', role: Role.ADMINISTRADOR } as never;
const C28 = '28282828-2828-4828-8828-282828282828';
const C29 = '29292929-2929-4929-8929-292929292929';
const finish = { code: 'ALZ-AZUL', kind: FinishKind.PREPINTADO, color: { code: 'AZUL' } };

function serviceWith(opts: {
  /** La línea hoy: con la bobina C28 o sin bobina. */
  current: 'COIL' | 'NONE';
  notes?: string | null;
  status?: string;
  coils?: { id: string; balance: string; thickness: string }[];
  /** Otra línea de la misma cotización que ya vende esa bobina. */
  otherLineWithCoil?: boolean;
  /** Una reserva temporal vigente sobre la cotización (D-185). */
  temporary?: boolean;
  /** Otra línea de la misma cotización vende C29 (el diálogo no la ofrece). */
  otherLineSellsC29?: boolean;
}) {
  const coils = opts.coils ?? [
    { id: C28, balance: '4200', thickness: '0.28' },
    { id: C29, balance: '4300', thickness: '0.29' },
  ];
  const item = {
    id: 'qi-1',
    lineNumber: 1,
    productId: 'p-028',
    qty: D('4192'),
    description: 'BOBINA ALUZINC AZUL 0.30 X 1200 RAL 5002',
    reserveItemType: opts.current === 'COIL' ? 'COIL' : 'PRODUCT',
    reserveItemId: opts.current === 'COIL' ? C28 : 'p-028',
    product: { sku: 'BOB028AZUL', name: 'Bobina Azul 0.28', businessLine: { code: 'TRADING' } },
  };
  const update = jest.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: 'q-1',
        seq: 7,
        status: opts.status ?? 'EMITTED',
        valid_until: null,
        created_by_id: 'u-1',
        seller_id: 'u-1',
        notes: opts.notes === undefined ? 'Factura externa: FFA1-1419' : opts.notes,
      },
    ]),
    quotationItem: {
      findFirst: jest.fn(({ where }: { where: { lineNumber?: number } }) =>
        Promise.resolve(
          where.lineNumber !== undefined ? item : opts.otherLineWithCoil ? { lineNumber: 2 } : null,
        ),
      ),
      // `findCoilTies` (otras cotizaciones) no trae nada; las otras líneas de esta cotización,
      // si se pide, venden C29.
      findMany: jest.fn(({ where }: { where: { quotationId?: string } }) =>
        Promise.resolve(
          where.quotationId !== undefined && opts.otherLineSellsC29 ? [{ reserveItemId: C29 }] : [],
        ),
      ),
      update,
    },
    quotationReservation: {
      findFirst: jest.fn().mockResolvedValue(opts.temporary ? { id: 'r-1' } : null),
    },
    color: { findMany: jest.fn().mockResolvedValue([{ code: 'AZUL' }]) },
    coil: {
      findMany: jest.fn().mockResolvedValue(
        coils.map((c) => ({
          id: c.id,
          code: `BOB-${c.thickness}`,
          widthMm: D('1200'),
          thicknessMm: D(c.thickness),
          finish,
        })),
      ),
    },
    inventoryBalance: {
      findMany: jest
        .fn()
        .mockResolvedValue(coils.map((c) => ({ itemId: c.id, qty: D(c.balance) }))),
    },
    businessLine: { findUnique: jest.fn().mockResolvedValue({ id: 'bl-t' }) },
    product: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'p-028', sku: 'BOB028AZUL', name: 'Bobina Azul 0.28', businessLineId: 'bl-t' },
        { id: 'p-029', sku: 'BOB029AZUL', name: 'Bobina Azul 0.29', businessLineId: 'bl-t' },
      ]),
    },
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const orders = { recalculateTemporaryInTx: jest.fn().mockResolvedValue(undefined) };
  const svc = Object.create(QuotationsService.prototype) as QuotationsService;
  Object.assign(svc, {
    env: { ROOFING_THICKNESS_TOLERANCE_MM: '' },
    prisma: { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) },
    audit,
    orders,
    generatePdf: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn().mockResolvedValue({ id: 'q-1' }),
  });
  return { svc, update, audit, orders };
}

describe('QuotationsService.setItemCoil (D-385 B)', () => {
  it('quitar la bobina deja la línea sin bobina, con su producto, y lo audita', async () => {
    const { svc, update, audit, orders } = serviceWith({ current: 'COIL' });
    await svc.setItemCoil(ACTOR, 'q-1', 1, { saleCoilId: null });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'qi-1' },
      data: {
        reserveItemType: 'PRODUCT',
        reserveItemId: 'p-028',
        reserveQty: D('4192'),
        reserveUnit: 'KGM',
      },
    });
    expect(audit.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'sales.quotation.item-coil',
        before: expect.objectContaining({ coilId: C28 }),
        after: expect.objectContaining({ coilId: null }),
      }),
    );
    expect(orders.recalculateTemporaryInTx).toHaveBeenCalled();
  });

  it('cambiarla por otra candidata toma la bobina y su producto; kilos del papel intactos', async () => {
    const { svc, update } = serviceWith({ current: 'COIL' });
    await svc.setItemCoil(ACTOR, 'q-1', 1, { saleCoilId: C29 });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'qi-1' },
      data: {
        productId: 'p-029',
        reserveItemType: 'COIL',
        reserveItemId: C29,
        reserveQty: D('4192'),
        reserveUnit: 'KGM',
      },
    });
  });

  it('una bobina más liviana que el papel no es candidata: se quita y se elige al confirmar', async () => {
    const { svc, update } = serviceWith({
      current: 'NONE',
      coils: [{ id: C28, balance: '4180', thickness: '0.28' }],
    });
    await expect(svc.setItemCoil(ACTOR, 'q-1', 1, { saleCoilId: C28 })).rejects.toThrow(
      /no es candidata .* quita la bobina y elígela al confirmar/,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('una bobina que ya vende otra línea del documento se rechaza', async () => {
    const { svc } = serviceWith({ current: 'NONE', otherLineWithCoil: true });
    await expect(svc.setItemCoil(ACTOR, 'q-1', 1, { saleCoilId: C28 })).rejects.toThrow(
      /ya la vende la línea 2/,
    );
  });

  it('en una cotización manual o confirmada no se toca', async () => {
    await expect(
      serviceWith({ current: 'COIL', notes: null }).svc.setItemCoil(ACTOR, 'q-1', 1, {
        saleCoilId: null,
      }),
    ).rejects.toThrow(/Solo en una cotización importada/);
    await expect(
      serviceWith({ current: 'COIL', status: 'CONFIRMED' }).svc.setItemCoil(ACTOR, 'q-1', 1, {
        saleCoilId: null,
      }),
    ).rejects.toThrow(/confirmada/);
  });

  it('con una reserva temporal vigente, quitar la bobina pide liberarla antes (P2-3)', async () => {
    const { svc, update } = serviceWith({ current: 'COIL', temporary: true });
    await expect(svc.setItemCoil(ACTOR, 'q-1', 1, { saleCoilId: null })).rejects.toThrow(
      /reserva temporal vigente: libérala antes de quitar la bobina/,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('la bobina que vende otra línea del documento no se ofrece como candidata (P3-2)', async () => {
    const { svc } = serviceWith({ current: 'COIL', otherLineSellsC29: true });
    await expect(svc.setItemCoil(ACTOR, 'q-1', 1, { saleCoilId: C29 })).rejects.toThrow(
      /no es candidata/,
    );
  });

  it('quitarla cuando ya no tiene bobina no escribe nada', async () => {
    const { svc, update, audit } = serviceWith({ current: 'NONE' });
    await svc.setItemCoil(ACTOR, 'q-1', 1, { saleCoilId: null });
    expect(update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});
