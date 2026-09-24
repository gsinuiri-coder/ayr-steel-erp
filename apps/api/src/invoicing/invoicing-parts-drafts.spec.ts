import {
  FiscalDocType,
  FiscalDocumentOrigin,
  FiscalDocumentStatus,
  Prisma,
  Role,
} from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { InvoicingService } from './invoicing.service';

/**
 * D-269 (a), P2-A de la autorrevisión del PR #16: la parte que cierra una línea toma el resto
 * **también cuando las otras partes siguen en borrador**. Lo prueba a nivel servicio —el
 * `groupBy` de los borradores y su uso en la factura y en la nota de crédito—; la aritmética
 * vive en `invoicing-math.spec.ts`.
 *
 * FFA1-1350: 4 194 kg por 12 439.83 / 2 239.17 / 14 679.00. Dos mitades recalculadas suman
 * 2 239.1694 de IGV y 14 678.9994 de total (D-265).
 */

const D = (v: string) => new Prisma.Decimal(v);
const LINE = { subtotalPen: '12439.8300', igvPen: '2239.1700', totalPen: '14679.0000' };
/** La primera mitad, recalculada desde el unitario derivado (lo que guardó el primer borrador). */
const HALF = {
  qty: '2097.000',
  subtotalPen: '6219.9150',
  igvPen: '1119.5847',
  totalPen: '7339.4997',
};

const ACTOR: RequestUser = {
  id: 'actor-1',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 'session-1',
};

type GroupWhere = { document: { status: unknown } };
const sum = (row: typeof HALF) => ({
  qty: D(row.qty),
  subtotalPen: D(row.subtotalPen),
  igvPen: D(row.igvPen),
  totalPen: D(row.totalPen),
});

/** `groupBy`: nada emitido; `drafts` en borrador, contra la clave `key`. */
function groupByWith(key: 'salesOrderItemId' | 'affectedItemId', drafts: (typeof HALF)[]) {
  return jest.fn(({ where }: { where: GroupWhere }) =>
    Promise.resolve(
      where.document.status === FiscalDocumentStatus.DRAFT
        ? drafts.map((d) => ({ [key]: 'line-1', _sum: sum(d) }))
        : [],
    ),
  );
}

describe('InvoicingService — la parte que cierra con las otras en borrador (D-269 a)', () => {
  describe('factura (resolveLines)', () => {
    const orderItem = {
      id: 'line-1',
      lineNumber: 1,
      qty: D('4194'),
      ...Object.fromEntries(Object.entries(LINE).map(([k, v]) => [k, D(v)])),
      productId: 'p-1',
      description: 'BOBINA ALUZINC',
      unit: 'KGM',
      product: { sku: 'BOB038AZUL' },
      salesOrder: { id: 'o-1', status: 'CONFIRMED', seq: 42, customerId: 'c-1' },
    };
    type Resolve = (tx: unknown, input: unknown) => Promise<(typeof HALF & { totalPen: string })[]>;
    const resolve = (drafts: (typeof HALF)[], qty: string) => {
      const service = Object.create(InvoicingService.prototype) as { resolveLines: Resolve };
      const tx = {
        salesOrderItem: { findMany: jest.fn().mockResolvedValue([orderItem]) },
        fiscalDocumentItem: { groupBy: groupByWith('salesOrderItemId', drafts) },
      };
      return service.resolveLines(tx, {
        salesOrderId: 'o-1',
        customerId: 'c-1',
        items: [{ salesOrderItemId: 'line-1', qty }],
      });
    };

    it('la segunda mitad, con la primera en borrador, cierra exactamente el papel', async () => {
      const [line] = await resolve([HALF], '2097.000');
      expect(D(line!.igvPen).plus(HALF.igvPen).toFixed(4)).toBe(LINE.igvPen);
      expect(D(line!.totalPen).plus(HALF.totalPen).toFixed(4)).toBe(LINE.totalPen);
    });

    it('sin borradores, una mitad se recalcula (no cierra)', async () => {
      const [line] = await resolve([], '2097.000');
      expect(line!.totalPen).toBe(HALF.totalPen);
    });

    it('borradores que se pisan con esta parte: se recalcula, y el tope sigue contra lo emitido', async () => {
      const [line] = await resolve([HALF], '3000.000');
      expect(D(line!.totalPen).gt(0)).toBe(true);
      expect(line!.totalPen).not.toBe(D(LINE.totalPen).minus(HALF.totalPen).toFixed(4));
    });
  });

  describe('nota de crédito (createCreditNote)', () => {
    const affectedItem = {
      id: 'line-1',
      lineNumber: 1,
      qty: D('4194'),
      ...Object.fromEntries(Object.entries(LINE).map(([k, v]) => [k, D(v)])),
      productId: 'p-1',
      description: 'BOBINA ALUZINC',
      unit: 'KGM',
      unitPricePen: D('2.9661'),
      salesOrderItemId: null,
    };
    async function credit(drafts: (typeof HALF)[]) {
      const create = jest.fn().mockResolvedValue({ id: 'nc-1' });
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        fiscalDocument: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'f-1',
            number: 'F001-1',
            docType: FiscalDocType.FACTURA,
            origin: FiscalDocumentOrigin.ERP,
            status: FiscalDocumentStatus.ACCEPTED,
            customerId: 'c-1',
            salesOrderId: 'o-1',
            createdById: ACTOR.id,
            items: [affectedItem],
            salesOrder: { sellerId: ACTOR.id },
            dispatch: null,
          }),
          create,
        },
        fiscalDocumentItem: { groupBy: groupByWith('affectedItemId', drafts) },
      };
      const service = Object.create(InvoicingService.prototype) as InvoicingService;
      Object.assign(service, {
        operationDate: { assertIssueDate: jest.fn() },
        prisma: { $transaction: (cb: (t: unknown) => unknown) => cb(tx) },
        audit: { write: jest.fn() },
        findOne: jest.fn().mockResolvedValue({ id: 'nc-1' }),
      });
      await service.createCreditNote(ACTOR, 'f-1', {
        reason: 'DEVOLUCION_TOTAL',
        issueDate: '2026-09-24',
        items: [{ affectedItemId: 'line-1', qty: '2097.000' }],
      } as never);
      const calls = create.mock.calls as [
        { data: { items: { create: { totalPen: string; igvPen: string }[] } } },
      ][];
      return calls[0]![0].data.items.create[0]!;
    }

    it('la segunda mitad acreditada, con la primera nota en borrador, cierra exactamente la línea', async () => {
      const line = await credit([HALF]);
      expect(D(line.igvPen).plus(HALF.igvPen).toFixed(4)).toBe(LINE.igvPen);
      expect(D(line.totalPen).plus(HALF.totalPen).toFixed(4)).toBe(LINE.totalPen);
    });

    it('sin notas en borrador, la mitad se recalcula', async () => {
      const line = await credit([]);
      expect(line.totalPen).toBe(HALF.totalPen);
    });
  });
});
