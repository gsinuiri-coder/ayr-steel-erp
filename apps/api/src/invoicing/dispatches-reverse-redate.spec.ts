import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { findLineReservation } from '../sales/reservation-transfer';
import { restoreReservationQty } from '../sales/reservation-guard';
import { DispatchesService } from './dispatches.service';

jest.mock('../sales/reservation-transfer', () => ({
  findLineReservation: jest.fn(),
  resolveDispatchTarget: jest.fn(),
}));
jest.mock('../sales/reservation-guard', () => ({
  consumeReservationQty: jest.fn(),
  restoreReservationQty: jest.fn(),
}));

/**
 * D-288: la reversa dentro de la transacción del llamador, en sus dos modos. La normal lleva la
 * fecha que se le da (hoy, D-124) y la bloquea cualquier comprobante declarado; la del
 * re-fechado va a la fecha del movimiento que anula, con el acuse de retrofecha, y el
 * comprobante que se corrige no la bloquea. En los dos, la reserva vuelve y el despacho queda
 * revertido y auditado.
 */

const ADMIN = { id: 'admin', role: 'ADMINISTRADOR' } as RequestUser;

/**
 * cc30: `lockDocuments` emite `SELECT "id" … WHERE "id" = ANY($ids) … FOR UPDATE` y devuelve las
 * filas que existían; el mock devuelve todos los ids pedidos, como si existieran.
 */
function lockedIds(_sql: TemplateStringsArray, ids?: unknown): Promise<{ id: string }[]> {
  return Promise.resolve(Array.isArray(ids) ? ids.map((id: string) => ({ id })) : []);
}

/** La tabla de cada `FOR UPDATE` emitido, en orden. */
function lockedTables(calls: unknown[][]): string[] {
  return calls.flatMap((c) => {
    const sql = (c[0] as string[]).join('?');
    if (!sql.includes('FOR UPDATE')) return [];
    const table = /FROM "([a-z_]+)"/.exec(sql)?.[1];
    return table ? [table] : [];
  });
}

function build(declaring: { id: string; number: string } | null = null) {
  const tx = {
    $queryRaw: jest.fn(lockedIds),
    dispatch: {
      findUnique: jest.fn().mockResolvedValue({ salesOrderId: 'ped' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'd-1',
        seq: 19,
        status: 'ISSUED',
        salesOrderId: 'ped',
        documents: [],
        items: [
          {
            salesOrderItemId: 'l1',
            itemType: 'PRODUCT',
            itemId: 'upvc',
            reserveQty: new Prisma.Decimal('50'),
            movementId: 327n,
          },
        ],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    inventoryMovement: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { businessLineId: 'trading', itemType: 'PRODUCT', itemId: 'upvc', unit: 'NIU' },
        ]),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ operationDate: new Date('2026-09-19T00:00:00.000Z') }),
    },
  };
  const inventory = {
    lockInOrder: jest.fn().mockResolvedValue(undefined),
    reverse: jest.fn().mockResolvedValue({}),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const svc = new DispatchesService({} as never, audit as never, inventory as never, {} as never);
  const internals = svc as unknown as Record<string, unknown>;
  const declaringDocument = jest.fn().mockResolvedValue(declaring);
  internals.declaringDocument = declaringDocument;
  internals.reopenRevertedCoils = jest.fn().mockResolvedValue([]);
  internals.recomputeOrderStatus = jest.fn().mockResolvedValue('CONFIRMED');
  return { svc, tx, inventory, audit, declaringDocument };
}

beforeEach(() => {
  jest.mocked(findLineReservation).mockResolvedValue({
    id: 'r',
    qty: new Prisma.Decimal(0) as never,
    status: 'CONSUMED',
    unit: 'NIU',
  } as never);
  jest.mocked(restoreReservationQty).mockResolvedValue(undefined as never);
});

describe('DispatchesService.reverseInTx (D-288)', () => {
  it('reversa normal: la fecha dada, sin acuse, y sin excepción de comprobante', async () => {
    const { svc, tx, inventory, audit, declaringDocument } = build();
    await svc.reverseInTx(tx as never, ADMIN, 'd-1', 'devolución', {
      operationDate: '2026-09-25',
    });
    expect(declaringDocument).toHaveBeenCalledWith(tx, expect.anything(), null);
    expect(inventory.reverse).toHaveBeenCalledWith(tx, 327n, 'admin', 'devolución', '2026-09-25');
    // D-386: la reserva y el conjunto de inventario se toman antes de la primera reversa.
    expect(inventory.lockInOrder).toHaveBeenCalledWith(tx, {
      coilIds: [],
      items: [{ businessLineId: 'trading', itemType: 'PRODUCT', itemId: 'upvc', unit: 'NIU' }],
    });
    expect(inventory.lockInOrder.mock.invocationCallOrder[0]).toBeLessThan(
      Number(inventory.reverse.mock.invocationCallOrder[0]),
    );
    // cc30 (D-471): despacho → pedido en una pasada por la puerta, y después la reserva.
    expect(lockedTables(tx.$queryRaw.mock.calls)).toEqual([
      'dispatches',
      'sales_orders',
      'reservations',
    ]);
    // El estado se lee con los dos ya tomados.
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      Number(tx.dispatch.findUniqueOrThrow.mock.invocationCallOrder[0]),
    );
    expect(restoreReservationQty).toHaveBeenCalled();
    expect(tx.dispatch.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'REVERSED' }) }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'invoicing.dispatch.reverse',
        after: expect.not.objectContaining({ redateOfInvoice: expect.anything() }),
      }),
    );
  });

  it('re-fechado: el inverso a la fecha del movimiento que anula, con acuse, y el comprobante exceptuado', async () => {
    const { svc, tx, inventory, audit, declaringDocument } = build();
    await svc.reverseInTx(tx as never, ADMIN, 'd-1', 'corrección', { redateInvoiceId: 'F1' });
    expect(declaringDocument).toHaveBeenCalledWith(tx, expect.anything(), 'F1');
    expect(inventory.reverse).toHaveBeenCalledWith(
      tx,
      327n,
      'admin',
      'corrección',
      '2026-09-19',
      true,
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ after: expect.objectContaining({ redateOfInvoice: 'F1' }) }),
    );
  });

  it('otro comprobante declarado bloquea también al re-fechado', async () => {
    const { svc, tx, inventory } = build({ id: 'F2', number: 'FFA1-2' });
    await expect(
      svc.reverseInTx(tx as never, ADMIN, 'd-1', 'corrección', { redateInvoiceId: 'F1' }),
    ).rejects.toThrow(BadRequestException);
    expect(inventory.reverse).not.toHaveBeenCalled();
  });
});
