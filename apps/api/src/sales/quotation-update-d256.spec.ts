import { Prisma } from '@prisma/client';
import { Role } from '@ayr/shared';
import { QuotationsService } from './quotations.service';
import { resolveSalesLines } from './sales-lines';

jest.mock('./sales-lines', () => ({
  resolveSalesLines: jest.fn().mockResolvedValue([]),
  documentTotals: () => ({ subtotalPen: '0.0000', igvPen: '0.0000', totalPen: '0.0000' }),
  toSalesItemDto: jest.fn(),
}));
jest.mock('./price-changes', () => ({
  recordPriceChanges: jest.fn().mockResolvedValue(0),
  findPriceChanges: jest.fn(),
}));
jest.mock('./coil-sale-product', () => ({
  lineCoilPool: jest.fn().mockResolvedValue({
    sku: 'BOB038AZUL',
    thicknessMm: '0.38',
    attribute: 'AZUL',
  }),
}));
jest.mock('../production/roofing-coil-match', () => ({ roofingToleranceMm: () => '0.05' }));

/**
 * D-256 (aclaración) en `QuotationsService.update`, de punta a punta con la base simulada: qué le
 * pide la edición a `resolveSalesLines` según el rol de quien edita un documento importado, y
 * qué deja en la auditoría (repaso de RF-S4b, P1-A: este cuerpo solo lo cubría el E2E).
 */
const D = (v: string) => new Prisma.Decimal(v);
const IMPORTED = 'Factura externa: FFA1-1350';

function build(notes: string | null) {
  const stored = [
    {
      productId: 'p-1',
      qty: D('10'),
      unitPricePen: D('5'),
      valuePerMeterPen: null,
      subtotalPen: D('50'),
      igvPen: D('9'),
      totalPen: D('59'),
      reserveItemType: 'COIL',
      reserveItemId: 'c-1',
      description: 'Bobina',
      product: { sku: 'BOB038AZUL', name: 'Bobina', businessLine: { code: 'TRADING' } },
      lineNumber: 1,
    },
  ];
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: 'q-1',
        seq: 2,
        status: 'EMITTED',
        valid_until: null,
        created_by_id: 'u-1',
        seller_id: 'u-1',
        notes,
      },
    ]),
    customer: {
      findUnique: jest.fn().mockResolvedValue({ id: 'c-1', name: 'Cliente', isActive: true }),
    },
    quotationItem: {
      findMany: jest.fn().mockResolvedValue(stored),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    quotation: { update: jest.fn().mockResolvedValue({}) },
  };
  const svc = Object.create(QuotationsService.prototype) as QuotationsService;
  Object.assign(svc, {
    env: {},
    prisma: { $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx) },
    audit,
    orders: { recalculateTemporaryInTx: jest.fn().mockResolvedValue(undefined) },
    generatePdf: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn().mockResolvedValue({ id: 'q-1' }),
  });
  return { svc, audit, tx };
}

const body = {
  customerId: 'c-1',
  issueDate: '2026-09-24',
  validityDays: 7,
  items: [
    // Intacta: la misma bobina, cantidad e importe guardados.
    { saleCoilId: 'c-1', qty: '10.000', netAmountPen: '50.0000' },
    // Cambiada: otro precio.
    { saleCoilId: 'c-2', qty: '5.000', unitPricePen: '1.0000' },
  ],
};
const optionsOf = () =>
  ((resolveSalesLines as jest.Mock).mock.calls.at(-1) as unknown[])[2] as Record<string, unknown>;

describe('QuotationsService.update — D-256 por rol en un documento importado', () => {
  beforeEach(() => {
    (resolveSalesLines as jest.Mock).mockClear();
  });

  it('VENDEDOR: con piso, y solo la línea intacta conserva el papel', async () => {
    const { svc } = build(IMPORTED);
    await svc.update({ id: 'u-1', role: Role.VENDEDOR } as never, 'q-1', body);
    const options = optionsOf();
    expect(options).toHaveProperty('priceFloor');
    expect(options).toHaveProperty('exactAmounts');
    expect([...(options.paperLines as Set<number>)]).toEqual([0]);
    expect(options.coilPool).toMatchObject({ scope: { exceptQuotationIds: ['q-1'] } });
    expect([...(options.coilPool as { allowedPools: Set<string> }).allowedPools]).toEqual([
      'BOB038AZUL',
    ]);
  });

  it('ADMINISTRADOR: sin piso y todas las líneas conservan el papel', async () => {
    const { svc } = build(IMPORTED);
    await svc.update({ id: 'u-1', role: Role.ADMINISTRADOR } as never, 'q-1', body);
    const options = optionsOf();
    expect(options).not.toHaveProperty('priceFloor');
    expect(options).not.toHaveProperty('paperLines');
  });

  it('un documento que no es importado: piso para todos y sin papel', async () => {
    const { svc } = build(null);
    await svc.update({ id: 'u-1', role: Role.ADMINISTRADOR } as never, 'q-1', body);
    const options = optionsOf();
    expect(options).toHaveProperty('priceFloor');
    expect(options).not.toHaveProperty('exactAmounts');
  });

  it('la edición que hace el barrido deja su motivo en la auditoría', async () => {
    const { svc, audit } = build(IMPORTED);
    await svc.update({ id: 'u-1', role: Role.ADMINISTRADOR } as never, 'q-1', body, {
      auditReason: 'Barrido de lo importado (RF-S4b)',
    });
    const entry = (audit.write.mock.calls[0] as unknown[])[1] as { reason?: string };
    expect(entry.reason).toBe('Barrido de lo importado (RF-S4b)');
  });
});
