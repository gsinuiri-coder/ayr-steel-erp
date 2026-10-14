import { randomUUID } from 'node:crypto';
import { PrismaClient, Role } from '@prisma/client';
import { BACKDATE_COST_MISMATCH, businessToday } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { InventoryService } from './inventory.service';

/**
 * cc52 (D-648) — **una salida con fecha atrasada que cambiaría de costo**, contra una base real.
 * Un ítem entra 10 u a S/ 10 el día −10 y 10 u a S/ 20 el día −2 (promedio de hoy 15). Una salida
 * fechada el día −5 saldría a 15 cuando a esa fecha el promedio era 10: se rechaza con los dos
 * costos; un ADMINISTRADOR la registra igual y queda auditada; otro rol, 403.
 */
const prisma = new PrismaClient();
const inventory = new InventoryService(
  prisma as unknown as PrismaService,
  { ROOFING_THICKNESS_TOLERANCE_MM: '0.02' } as Env,
  new AuditService(prisma as unknown as PrismaService),
);

let businessLineId = '';
let adminId = '';
let sellerId = '';
const TODAY = businessToday();
const daysAgo = (n: number) =>
  new Date(Date.parse(`${TODAY}T12:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  assertTestDatabase();
  const line = await prisma.businessLine.findFirst({
    where: { inventoryStrategy: { not: 'NOOP' } },
    select: { id: true },
  });
  const admin = await prisma.user.findFirst({
    where: { role: Role.ADMINISTRADOR },
    select: { id: true },
  });
  if (!line || !admin) throw new Error('La base de pruebas no tiene seed (líneas o usuarios)');
  businessLineId = line.id;
  adminId = admin.id;
  sellerId = (
    await prisma.user.create({
      data: {
        email: `vendedor-cc52-${randomUUID()}@ayr.test`,
        name: 'Vendedor cc52',
        passwordHash: 'x',
        role: Role.VENDEDOR,
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function entry(itemId: string, qty: string, unitCost: string, operationDate: string) {
  return prisma.$transaction((tx) =>
    inventory.record(tx, {
      businessLineId,
      itemType: 'PRODUCT',
      itemId,
      type: 'IN',
      qty,
      unit: 'NIU',
      unitCost,
      refType: 'PURCHASE',
      actorId: adminId,
      operationDate,
      confirmBackdate: true,
    }),
  );
}

function exit(
  itemId: string,
  operationDate: string,
  options: { actorId?: string; accept?: boolean } = {},
) {
  return prisma.$transaction((tx) =>
    inventory.record(tx, {
      businessLineId,
      itemType: 'PRODUCT',
      itemId,
      type: 'OUT',
      qty: '4',
      unit: 'NIU',
      refType: 'SALE',
      actorId: options.actorId ?? adminId,
      operationDate,
      confirmBackdate: true,
      acceptBackdatedCost: options.accept,
    }),
  );
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    const e = err as { getStatus?: () => number; getResponse?: () => unknown };
    return { status: e.getStatus?.() ?? 500, body: e.getResponse?.() as Record<string, unknown> };
  }
  throw new Error('Se esperaba un rechazo');
}

async function stocked(): Promise<string> {
  const itemId = randomUUID();
  await entry(itemId, '10', '10.0000', daysAgo(10));
  await entry(itemId, '10', '20.0000', daysAgo(2));
  return itemId;
}

describe('cc52 (D-648): salida atrasada que cambia de costo', () => {
  it('se rechaza con el costo que usaría y el promedio a su fecha, sin escribir nada', async () => {
    const itemId = await stocked();
    const r = await rejection(exit(itemId, daysAgo(5)));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({
      code: BACKDATE_COST_MISMATCH,
      costUsed: '15.0000',
      costAtDate: '10.0000',
    });
    expect(String(r.body.message)).toContain('S/ 15.0000');
    expect(String(r.body.message)).toContain('S/ 10.0000');
    expect(await prisma.inventoryMovement.count({ where: { itemId, type: 'OUT' } })).toBe(0);
  });

  it('otro rol no la registra igual: 403', async () => {
    const itemId = await stocked();
    const r = await rejection(exit(itemId, daysAgo(5), { actorId: sellerId, accept: true }));
    expect(r.status).toBe(403);
    expect(await prisma.inventoryMovement.count({ where: { itemId, type: 'OUT' } })).toBe(0);
  });

  it('el administrador la registra igual: sale al promedio de hoy y queda auditada con los dos costos', async () => {
    const itemId = await stocked();
    const movement = await exit(itemId, daysAgo(5), { accept: true });
    expect(movement?.unitCost.toFixed(4)).toBe('15.0000');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        action: 'inventory.backdated-cost-accepted',
        entity: 'inventory_movements',
        entityId: movement?.id.toString(),
      },
    });
    expect(audit.actorId).toBe(adminId);
    expect(audit.after).toMatchObject({
      costUsed: '15.0000',
      costAtDate: '10.0000',
      operationDate: daysAgo(5),
      laterCount: 1,
    });
  });

  it('una entrada posterior al mismo costo no cambia nada: pasa sin acuse', async () => {
    const itemId = randomUUID();
    await entry(itemId, '10', '10.0000', daysAgo(10));
    await entry(itemId, '10', '10.0000', daysAgo(2));
    const movement = await exit(itemId, daysAgo(5));
    expect(movement?.unitCost.toFixed(4)).toBe('10.0000');
  });

  it('una salida posterior a la última entrada, o de hoy, no se toca', async () => {
    const itemId = await stocked();
    expect((await exit(itemId, daysAgo(1)))?.unitCost.toFixed(4)).toBe('15.0000');
    expect((await exit(itemId, TODAY))?.unitCost.toFixed(4)).toBe('15.0000');
  });
});
