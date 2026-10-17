import { Role } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { CoilOperationsService } from '../coils/coil-operations.service';
import { DispatchesService } from '../invoicing/dispatches.service';
import { QuotationsService } from '../sales/quotations.service';
import { SalesOrdersService } from '../sales/sales-orders.service';

/**
 * cc57 (B-02 de audit-01) — las creaciones repetibles reclaman la clave antes que nada: si ya se
 * procesó, devuelven el recurso del primero sin repetir el efecto; si no, crean con el id de la
 * clave. Con una base falsa; lo mismo contra una base real en `idempotency-creates.db-spec.ts`.
 */
const ADMIN = { id: 'u-1', role: Role.ADMINISTRADOR } as RequestUser;

/** Un `tx` cuyo reclamo gana (`claimed`) o encuentra el intento anterior (`resourceId`). */
function tx(claimed: boolean, scope: string) {
  return {
    $queryRaw: jest.fn().mockResolvedValue(claimed ? [{ resource_id: 'nuevo' }] : []),
    idempotencyKey: {
      findUnique: jest.fn().mockResolvedValue({ scope, resourceId: 'anterior' }),
    },
    coil: { findMany: jest.fn().mockResolvedValue([{ id: 'hija-1' }, { id: 'hija-2' }]) },
  };
}

function prismaOf(t: ReturnType<typeof tx>) {
  return { $transaction: jest.fn((fn: (x: unknown) => Promise<unknown>) => fn(t)) };
}

/** El servicio sin su constructor: solo lo que `create` toca. */
function bare<T extends object>(proto: T, fields: Record<string, unknown>): T {
  return Object.assign(Object.create(proto) as T, fields);
}

describe('cc57 (B-02): pedido directo', () => {
  it('el reintento devuelve el pedido del primero sin crear otro', async () => {
    const createDirectInTx = jest.fn();
    const findOne = jest.fn().mockResolvedValue({ id: 'anterior' });
    const svc = bare(SalesOrdersService.prototype, {
      prisma: prismaOf(tx(false, 'sales-order-direct')),
      createDirectInTx,
      findOne,
    });
    await svc.createDirect(ADMIN, { idempotencyKey: 'k-1', items: [] } as never);
    expect(createDirectInTx).not.toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledWith('anterior');
  });

  it('el primero crea con el id de la clave', async () => {
    const createDirectInTx = jest.fn().mockResolvedValue('nuevo-id');
    const svc = bare(SalesOrdersService.prototype, {
      prisma: prismaOf(tx(true, 'sales-order-direct')),
      createDirectInTx,
      findOne: jest.fn().mockResolvedValue({}),
    });
    await svc.createDirect(ADMIN, { idempotencyKey: 'k-1', items: [] } as never);
    expect(createDirectInTx).toHaveBeenCalledWith(expect.anything(), ADMIN, expect.anything(), {
      id: expect.any(String) as unknown,
    });
  });
});

describe('cc57 (B-02): cotización', () => {
  it('el reintento no crea otra ni vuelve a generar el PDF', async () => {
    const createInTx = jest.fn();
    const generatePdf = jest.fn();
    const svc = bare(QuotationsService.prototype, {
      prisma: prismaOf(tx(false, 'quotation-create')),
      createInTx,
      generatePdf,
      findOne: jest.fn().mockResolvedValue({ id: 'anterior' }),
    });
    const out = await svc.create(ADMIN, { idempotencyKey: 'k-1', items: [] } as never);
    expect(out).toEqual({ id: 'anterior' });
    expect(createInTx).not.toHaveBeenCalled();
    expect(generatePdf).not.toHaveBeenCalled();
  });

  it('el primero crea con el id de la clave y genera el PDF', async () => {
    const createInTx = jest.fn().mockResolvedValue('nuevo-id');
    const generatePdf = jest.fn().mockResolvedValue(undefined);
    const svc = bare(QuotationsService.prototype, {
      prisma: prismaOf(tx(true, 'quotation-create')),
      createInTx,
      generatePdf,
      findOne: jest.fn().mockResolvedValue({ id: 'nuevo-id' }),
    });
    await svc.create(ADMIN, { idempotencyKey: 'k-1', items: [] } as never);
    expect(createInTx).toHaveBeenCalledWith(expect.anything(), ADMIN, expect.anything(), {
      id: expect.any(String) as unknown,
    });
    expect(generatePdf).toHaveBeenCalledWith('nuevo-id');
  });
});

describe('cc57 (B-02): despacho', () => {
  it('el reintento devuelve el despacho del primero sin volver a sacar del kardex', async () => {
    const createInTx = jest.fn();
    const findOne = jest.fn().mockResolvedValue({ id: 'anterior' });
    const svc = bare(DispatchesService.prototype, {
      prisma: prismaOf(tx(false, 'dispatch-create')),
      createInTx,
      findOne,
    });
    await svc.create(ADMIN, { idempotencyKey: 'k-1', items: [] } as never);
    expect(createInTx).not.toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledWith('anterior');
  });

  it('el primero crea con el id de la clave', async () => {
    const createInTx = jest.fn().mockResolvedValue('nuevo-id');
    const svc = bare(DispatchesService.prototype, {
      prisma: prismaOf(tx(true, 'dispatch-create')),
      createInTx,
      findOne: jest.fn().mockResolvedValue({}),
    });
    await svc.create(ADMIN, { idempotencyKey: 'k-1', items: [] } as never);
    expect(createInTx).toHaveBeenCalledWith(expect.anything(), ADMIN, expect.anything(), {
      id: expect.any(String) as unknown,
    });
  });
});

describe('cc57 (B-02): partido y merma de bobina', () => {
  function coilOps(claimed: boolean, scope: string) {
    const t = tx(claimed, scope);
    const lockCoil = jest.fn().mockRejectedValue(new Error('no debería bloquear la bobina'));
    const findOne = jest.fn((id: string) => Promise.resolve({ id }));
    const svc = bare(CoilOperationsService.prototype, {
      prisma: prismaOf(t),
      operationDate: { resolve: jest.fn().mockReturnValue('2026-10-17') },
      coils: { lockCoil, findOne },
    });
    return { svc, t, lockCoil, findOne };
  }

  it('el reintento de un partido devuelve las hijas del primero y no parte otra vez', async () => {
    const { svc, t, lockCoil } = coilOps(false, 'coil-split');
    const out = await svc.split(ADMIN, 'madre', { idempotencyKey: 'k-1', children: [] } as never);
    expect(out.map((c) => c.id)).toEqual(['hija-1', 'hija-2']);
    expect(t.coil.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { splitId: 'anterior' } }),
    );
    expect(lockCoil).not.toHaveBeenCalled();
  });

  it('el reintento de una merma devuelve la bobina sin mermar otra vez', async () => {
    const { svc, lockCoil, findOne } = coilOps(false, 'coil-scrap');
    await svc.registerScrap(ADMIN, 'bobina-1', { idempotencyKey: 'k-1', qtyKg: '5' } as never);
    expect(lockCoil).not.toHaveBeenCalled();
    expect(findOne).toHaveBeenCalledWith('bobina-1');
  });
});
