import { Prisma } from '@prisma/client';
import type { RequestUser } from '../auth/auth.types';
import { DispatchesService } from './dispatches.service';

/**
 * D-285: la salida que le falta a una línea de despacho ya registrada. Se agrega al despacho
 * (no se rehace): `OUT` de venta con la fecha del despacho, enlazado a la línea y auditado.
 */

const ADMIN = { id: 'admin', role: 'ADMINISTRADOR' } as RequestUser;

function build(item: { movementId: bigint | null; status: 'ISSUED' | 'REVERSED' }) {
  const tx = {
    dispatchItem: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'di-1',
        dispatchId: 'd-1',
        lineNumber: 1,
        itemType: 'PRODUCT',
        itemId: 'upvc',
        unit: 'NIU',
        reserveQty: new Prisma.Decimal('50'),
        movementId: item.movementId,
        dispatch: {
          seq: 4,
          status: item.status,
          dispatchDate: new Date('2026-08-11T00:00:00.000Z'),
          salesOrder: { seq: 22 },
        },
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    inventoryBalance: { findUnique: jest.fn().mockResolvedValue({ unit: 'NIU' }) },
  };
  const inventory = {
    resolveItemBusinessLineId: jest.fn().mockResolvedValue('bl'),
    record: jest.fn().mockResolvedValue({ id: 99n, totalCost: new Prisma.Decimal('2161.0150') }),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const svc = new DispatchesService({} as never, audit as never, inventory as never, {} as never);
  return { svc, tx, inventory, audit };
}

describe('DispatchesService.addMissingMovementInTx (D-285)', () => {
  it('agrega el OUT de venta con la fecha del despacho, lo enlaza y lo audita', async () => {
    const { svc, tx, inventory, audit } = build({ movementId: null, status: 'ISSUED' });
    const result = await svc.addMissingMovementInTx(tx as never, ADMIN, 'di-1', 'motivo');
    expect(inventory.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: 'OUT',
        refType: 'SALE',
        refId: 'd-1',
        qty: '50.000',
        unit: 'NIU',
        operationDate: '2026-08-11',
        confirmBackdate: true,
      }),
    );
    expect(tx.dispatchItem.update).toHaveBeenCalledWith({
      where: { id: 'di-1' },
      data: { movementId: 99n },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'invoicing.dispatch.add-movement',
        after: expect.objectContaining({ reason: 'motivo', totalCost: '2161.0150' }) as unknown,
      }),
    );
    expect(result.totalCost).toBe('2161.0150');
  });

  it('no agrega una segunda salida ni la agrega a un despacho revertido', async () => {
    const withMovement = build({ movementId: 5n, status: 'ISSUED' });
    await expect(
      withMovement.svc.addMissingMovementInTx(withMovement.tx as never, ADMIN, 'di-1', 'm'),
    ).rejects.toThrow('ya tiene su salida');
    const reversed = build({ movementId: null, status: 'REVERSED' });
    await expect(
      reversed.svc.addMissingMovementInTx(reversed.tx as never, ADMIN, 'di-1', 'm'),
    ).rejects.toThrow('revertido');
    expect(reversed.inventory.record).not.toHaveBeenCalled();
  });
});
