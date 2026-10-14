import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BACKDATE_COST_MISMATCH, Decimal } from '@ayr/shared';
import type { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';

/**
 * cc52 (D-648) — la decisión de `record` ante una salida con fecha atrasada, con un `tx` falso. La
 * misma regla contra una base real vive en `backdated-cost.db-spec.ts`.
 */
type Check = (
  tx: unknown,
  input: Record<string, unknown>,
  operationDate: string,
  balance: { id: string; qty: Decimal; avgCost: Decimal; unit: string },
) => Promise<{ costUsed: string; costAtDate: string; laterCount: number; label: string } | null>;

function setup(options: {
  laterCount: number;
  atDate?: { qty: string; value: string };
  role?: string;
}) {
  const tx = {
    inventoryMovement: { count: jest.fn().mockResolvedValue(options.laterCount) },
    $queryRaw: jest.fn().mockResolvedValue([
      {
        qty: { toString: () => options.atDate?.qty ?? '0' },
        value: { toString: () => options.atDate?.value ?? '0' },
      },
    ]),
    user: { findUnique: jest.fn().mockResolvedValue({ role: options.role ?? 'ADMINISTRADOR' }) },
  };
  const service = new InventoryService(
    {} as PrismaService,
    { ROOFING_THICKNESS_TOLERANCE_MM: '' } as Env,
    {} as AuditService,
  );
  const internals = service as unknown as {
    assertBackdatedCost: Check;
    resolveItemLabels: () => Promise<Map<string, { code: string; name: string }>>;
  };
  internals.resolveItemLabels = jest
    .fn()
    .mockResolvedValue(new Map([['PRODUCT:p-1', { code: 'UPVC6MT', name: 'UPVC' }]]));
  const check = (operationDate: string, accept?: boolean) =>
    internals.assertBackdatedCost.call(
      service,
      tx,
      {
        itemType: 'PRODUCT',
        itemId: 'p-1',
        unit: 'NIU',
        qty: '24',
        actorId: 'u-1',
        acceptBackdatedCost: accept,
      },
      operationDate,
      { id: 'b-1', qty: new Decimal('498'), avgCost: new Decimal('70.7924'), unit: 'NIU' },
    );
  return { tx, check };
}

const UPVC_AT_DATE = { qty: '416', value: '31023.7408' };

describe('InventoryService.assertBackdatedCost (cc52, D-648)', () => {
  it('una salida de hoy (o futura) no consulta nada', async () => {
    const { tx, check } = setup({ laterCount: 3 });
    await expect(check('2999-01-01')).resolves.toBeNull();
    expect(tx.inventoryMovement.count).not.toHaveBeenCalled();
  });

  it('sin entradas ni ajustes posteriores, no avisa ni calcula el saldo a la fecha', async () => {
    const { tx, check } = setup({ laterCount: 0 });
    await expect(check('2026-09-03')).resolves.toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('con el mismo promedio a la fecha, no avisa', async () => {
    const { check } = setup({ laterCount: 1, atDate: { qty: '100', value: '7079.24' } });
    await expect(check('2026-09-03')).resolves.toBeNull();
  });

  it('si el costo cambia, 400 con el código, los dos costos y el ítem', async () => {
    const { check } = setup({ laterCount: 1, atDate: UPVC_AT_DATE });
    const error = await check('2026-09-03').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: BACKDATE_COST_MISMATCH,
      costUsed: '70.7924',
      costAtDate: '74.5763',
    });
    expect((error as BadRequestException).message).toContain('UPVC6MT');
  });

  it('«Registrar igual» de otro rol: 403', async () => {
    const { check } = setup({ laterCount: 1, atDate: UPVC_AT_DATE, role: 'VENDEDOR' });
    await expect(check('2026-09-03', true)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('«Registrar igual» del administrador: pasa y devuelve los dos costos para auditarlos', async () => {
    const { check } = setup({ laterCount: 2, atDate: UPVC_AT_DATE });
    await expect(check('2026-09-03', true)).resolves.toEqual({
      costUsed: '70.7924',
      costAtDate: '74.5763',
      laterCount: 2,
      label: 'UPVC6MT',
    });
  });
});
