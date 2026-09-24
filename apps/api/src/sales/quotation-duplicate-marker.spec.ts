import { Prisma } from '@prisma/client';
import { Role } from '@ayr/shared';
import { QuotationsService } from './quotations.service';

jest.mock('./sales-lines', () => ({
  resolveSalesLines: jest.fn().mockResolvedValue([]),
  documentTotals: () => ({ subtotalPen: '5.0000', igvPen: '0.9000', totalPen: '5.9000' }),
  toSalesItemDto: jest.fn(),
}));

/**
 * D-256 (3), repaso de RF-S4b (P2-2): el duplicado de una cotización importada es una cotización
 * viva de hoy (D-157), no el comprobante. Nace **sin** la marca `Factura externa:`: con ella
 * quedaba exenta al editarla y el barrido la tomaba como un segundo documento del mismo papel.
 */
describe('QuotationsService.duplicate — la marca del importador no se hereda', () => {
  it('el duplicado de una importada conserva las observaciones del usuario, sin la marca', async () => {
    const D = (v: string) => new Prisma.Decimal(v);
    const created: { notes?: string | null }[] = [];
    const tx = {
      customer: {
        findUnique: jest.fn().mockResolvedValue({ id: 'c-1', name: 'Cliente', isActive: true }),
      },
      quotation: {
        create: jest.fn(({ data }: { data: { notes: string | null } }) => {
          created.push(data);
          return Promise.resolve({ id: 'q-2', seq: 12 });
        }),
      },
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
            sellerId: 'u-1',
            notes: 'Factura externa: FFA1-1350\nEntregar en obra',
            items: [
              {
                productId: 'p-1',
                description: 'Plancha',
                qty: D('1'),
                unitPricePen: D('5'),
                valuePerMeterPen: null,
                subtotalPen: D('5'),
                pieces: [],
                reserveItemType: 'PRODUCT',
                reserveItemId: 'p-1',
                reserveQty: D('1'),
              },
            ],
          }),
        },
        productBom: { findMany: jest.fn().mockResolvedValue([]) },
        $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      },
      audit: { write: jest.fn().mockResolvedValue(undefined) },
      generatePdf: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue({ id: 'q-2' }),
    });

    await svc.duplicate({ id: 'u-1', role: Role.ADMINISTRADOR } as never, 'q-1');
    expect(created[0]?.notes).toBe('Entregar en obra');
  });
});
