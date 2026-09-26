import { Prisma } from '@prisma/client';
import { Role } from '@ayr/shared';
import { QuotationsService } from './quotations.service';
import { reservedByItem } from './reserved-ledger';
import { resolveSalesLines } from './sales-lines';

jest.mock('./sales-lines', () => ({
  resolveSalesLines: jest.fn().mockResolvedValue([]),
  documentTotals: () => ({ subtotalPen: '5.0000', igvPen: '0.9000', totalPen: '5.9000' }),
  toSalesItemDto: jest.fn(),
}));
jest.mock('./reserved-ledger', () => ({ reservedByItem: jest.fn() }));

/**
 * D-322 (M0.3 de correcciones 04): duplicar una cotización con una bobina entera que sigue atada a
 * otra cotización abierta **se crea**. Esa línea viaja como el producto `BOB…` sin bobina, y la
 * respuesta trae el aviso. Una bobina libre se copia como venta de bobina, como siempre.
 */

const D = (v: string) => new Prisma.Decimal(v);
const ACTOR = { id: 'u-1', role: Role.ADMINISTRADOR } as never;

function serviceWith(opts: {
  tied: boolean;
  sellerId?: string | null;
  owner?: string;
  /** Kilos que la bobina tiene reservados (un pedido confirmado los promete); 0 = libre. */
  reservedKg?: string;
  /** Saldo de kardex de la bobina. */
  balanceKg?: string;
  coilStatus?: string;
}) {
  (reservedByItem as jest.Mock).mockResolvedValue(
    new Map(opts.reservedKg ? [['coil-1', D(opts.reservedKg)]] : []),
  );
  const tx = {
    customer: {
      findUnique: jest.fn().mockResolvedValue({ id: 'c-1', name: 'Cliente', isActive: true }),
    },
    quotation: { create: jest.fn().mockResolvedValue({ id: 'q-2', seq: 12 }) },
  };
  const svc = Object.create(QuotationsService.prototype) as QuotationsService;
  Object.assign(svc, {
    env: {},
    prisma: {
      quotation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'q-1',
          seq: 2,
          customerId: 'c-1',
          sellerId: opts.owner ?? 'u-1',
          notes: null,
          items: [
            {
              lineNumber: 1,
              productId: 'p-bob',
              description: 'Bobina',
              qty: D('4194'),
              unitPricePen: D('3.5'),
              valuePerMeterPen: null,
              subtotalPen: D('14679'),
              pieces: [],
              reserveItemType: 'COIL',
              reserveItemId: 'coil-1',
              reserveQty: D('4194'),
            },
          ],
        }),
      },
      productBom: { findMany: jest.fn().mockResolvedValue([]) },
      quotationItem: {
        findMany: jest.fn().mockResolvedValue(
          opts.tied
            ? [
                {
                  reserveItemId: 'coil-1',
                  quotation: { seq: 2, sellerId: opts.sellerId ?? 'u-1' },
                },
              ]
            : [],
        ),
      },
      coil: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'coil-1', code: 'SALDO-AZUL-4194', status: opts.coilStatus ?? 'OPEN' },
          ]),
      },
      inventoryBalance: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ itemId: 'coil-1', qty: D(opts.balanceKg ?? '4194') }]),
      },
      $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    },
    audit: { write: jest.fn().mockResolvedValue(undefined) },
    generatePdf: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn().mockResolvedValue({ id: 'q-2' }),
  });
  return svc;
}

beforeEach(() => (resolveSalesLines as jest.Mock).mockClear());

describe('QuotationsService.duplicate — bobina entera atada a otra cotización (D-322)', () => {
  it('la copia se crea con la línea BOB… sin bobina y avisa a cuál sigue atada', async () => {
    const out = await serviceWith({ tied: true }).duplicate(ACTOR, 'q-1');
    expect(out.warnings).toEqual([
      'Línea 1: la bobina SALDO-AZUL-4194 sigue atada a COT-000002; elegí otra con «Bobina completa (venta directa)».',
    ]);
    const call = (resolveSalesLines as jest.Mock).mock.calls[0] as [
      unknown,
      Record<string, unknown>[],
      { unassignedCoilProducts: Set<string> },
    ];
    expect(call[1][0]).toMatchObject({ productId: 'p-bob', qty: '4194.000' });
    expect(call[1][0]).not.toHaveProperty('saleCoilId');
    expect([...call[2].unassignedCoilProducts]).toEqual(['p-bob']);
  });

  it('a un VENDEDOR no se le nombra la cotización de otro vendedor', async () => {
    const out = await serviceWith({ tied: true, sellerId: 'otro', owner: 'u-2' }).duplicate(
      { id: 'u-2', role: Role.VENDEDOR } as never,
      'q-1',
    );
    // El alcance de la cotización original ya lo exige `assertSellerAccess`; acá solo se prueba el texto.
    expect(out.warnings[0]).toContain('sigue tomada por otro documento');
    expect(out.warnings[0]).not.toContain('COT-');
  });

  it('una bobina libre se copia como venta de bobina, sin avisos', async () => {
    const out = await serviceWith({ tied: false }).duplicate(ACTOR, 'q-1');
    expect(out.warnings).toEqual([]);
    const call = (resolveSalesLines as jest.Mock).mock.calls[0] as [
      unknown,
      Record<string, unknown>[],
      { unassignedCoilProducts: Set<string> },
    ];
    expect(call[1][0]).toMatchObject({ saleCoilId: 'coil-1' });
    expect(call[2].unassignedCoilProducts.size).toBe(0);
  });

  // Revisión independiente (A-1): duplicar una cotización CONFIRMADA (la bobina la reserva su
  // propio pedido), despachada (saldo 0) o anulada daba un 400 y no duplicaba nada.
  it.each([
    ['reservada por su propio pedido confirmado', { reservedKg: '4194' }],
    ['ya despachada (saldo 0)', { balanceKg: '0' }],
    ['anulada', { coilStatus: 'CANCELLED' }],
  ])('una bobina %s se copia como BOB… sin bobina y avisa por qué', async (_label, opts) => {
    const out = await serviceWith({ tied: false, ...opts }).duplicate(ACTOR, 'q-1');
    expect(out.warnings).toEqual([
      'Línea 1: la bobina SALDO-AZUL-4194 ya no tiene saldo para vender (reservada, despachada o fuera de servicio); elegí otra con «Bobina completa (venta directa)».',
    ]);
    const call = (resolveSalesLines as jest.Mock).mock.calls[0] as [
      unknown,
      Record<string, unknown>[],
      { unassignedCoilProducts: Set<string> },
    ];
    expect(call[1][0]).not.toHaveProperty('saleCoilId');
    expect([...call[2].unassignedCoilProducts]).toEqual(['p-bob']);
  });
});
