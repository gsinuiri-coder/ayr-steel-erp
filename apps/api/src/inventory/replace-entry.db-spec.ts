import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { businessToday } from '@ayr/shared';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { InventoryService } from './inventory.service';

/**
 * D-372 (cc15b) — `InventoryService.replaceEntry` **contra una base real**: la precondición se
 * comprueba en SQL bajo el lock del saldo, y dos reemplazos simultáneos del mismo ingreso compiten
 * por ese lock. Un mock no prueba ninguna de las dos cosas.
 *
 * Los ítems son UUID sueltos: `inventory_movements`/`inventory_balances` son polimórficos (§3.2,
 * sin FK al producto), así que cada test arma su propio ítem y no pisa a los demás.
 */
const prisma = new PrismaClient();
const inventory = new InventoryService(
  prisma as unknown as PrismaService,
  {
    ROOFING_THICKNESS_TOLERANCE_MM: '0.02',
  } as Env,
);

let businessLineId = '';
let actorId = '';
const TODAY = businessToday();

beforeAll(async () => {
  assertTestDatabase();
  const line = await prisma.businessLine.findFirst({
    where: { inventoryStrategy: { not: 'NOOP' } },
    select: { id: true },
  });
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!line || !user) throw new Error('La base de pruebas no tiene seed (líneas o usuarios)');
  businessLineId = line.id;
  actorId = user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function item(): { itemId: string } {
  return { itemId: randomUUID() };
}

async function entry(itemId: string, qty: string, totalCost: string): Promise<bigint> {
  const movement = await prisma.$transaction((tx) =>
    inventory.record(tx, {
      businessLineId,
      itemType: 'PRODUCT',
      itemId,
      type: 'IN',
      qty,
      unit: 'NIU',
      unitCost: (Number(totalCost) / Number(qty)).toFixed(4),
      totalCost,
      refType: 'PURCHASE',
      actorId,
    }),
  );
  if (!movement) throw new Error('La línea no lleva stock');
  return movement.id;
}

async function balance(itemId: string): Promise<{ qty: string; avgCost: string }> {
  const row = await prisma.inventoryBalance.findUniqueOrThrow({
    where: { itemType_itemId: { itemType: 'PRODUCT', itemId } },
    select: { qty: true, avgCost: true },
  });
  return { qty: row.qty.toFixed(3), avgCost: row.avgCost.toFixed(4) };
}

function replace(movementId: bigint, qty: string, totalCost: string) {
  return prisma.$transaction((tx) =>
    inventory.replaceEntry(tx, {
      movementId,
      qty,
      unitCost: (Number(totalCost) / Number(qty)).toFixed(4),
      totalCost,
      actorId,
      reason: 'db-spec replaceEntry',
    }),
  );
}

describe('InventoryService.replaceEntry contra la base', () => {
  it('reemplaza en la misma fecha: la reversa y el ingreso nuevo, y el saldo con el costo nuevo', async () => {
    const { itemId } = item();
    const id = await entry(itemId, '100', '500');
    const { reversal, entry: next } = await replace(id, '100', '550');
    expect(reversal).toMatchObject({ type: 'OUT', reversalOfId: id });
    expect(next).toMatchObject({ type: 'IN', reversalOfId: null });
    expect(reversal.operationDate.toISOString().slice(0, 10)).toBe(TODAY);
    expect(await balance(itemId)).toEqual({ qty: '100.000', avgCost: '5.5000' });
  });

  it('volver al valor anterior deja el saldo exacto', async () => {
    const { itemId } = item();
    const id = await entry(itemId, '1000', '5000');
    const first = await replace(id, '1000', '5500');
    await replace(first.entry.id, '1000', '5000');
    expect(await balance(itemId)).toEqual({ qty: '1000.000', avgCost: '5.0000' });
  });

  it('precondición: con una salida posterior, se rechaza y no escribe nada', async () => {
    const { itemId } = item();
    const id = await entry(itemId, '100', '500');
    await prisma.$transaction((tx) =>
      inventory.record(tx, {
        businessLineId,
        itemType: 'PRODUCT',
        itemId,
        type: 'OUT',
        qty: '10',
        unit: 'NIU',
        refType: 'SALE',
        actorId,
      }),
    );
    await expect(replace(id, '100', '550')).rejects.toThrow(/movimiento posterior/);
    expect(await balance(itemId)).toEqual({ qty: '90.000', avgCost: '5.0000' });
    expect(await prisma.inventoryMovement.count({ where: { itemId } })).toBe(2);
  });

  it('precondición: con un ajuste de costo posterior, también', async () => {
    const { itemId } = item();
    const id = await entry(itemId, '100', '500');
    await prisma.$transaction((tx) =>
      inventory.adjustCost(tx, {
        businessLineId,
        itemType: 'PRODUCT',
        itemId,
        unit: 'NIU',
        amountPen: '50',
        refType: 'PURCHASE',
        actorId,
      }),
    );
    await expect(replace(id, '100', '550')).rejects.toThrow(/movimiento posterior/);
  });

  it('una salida posterior ya anulada no cuenta; otra entrada posterior tampoco (punto 4)', async () => {
    const { itemId } = item();
    const id = await entry(itemId, '100', '500');
    const out = await prisma.$transaction((tx) =>
      inventory.record(tx, {
        businessLineId,
        itemType: 'PRODUCT',
        itemId,
        type: 'OUT',
        qty: '10',
        unit: 'NIU',
        refType: 'SALE',
        actorId,
      }),
    );
    await prisma.$transaction((tx) => inventory.reverse(tx, out!.id, actorId, 'anulada'));
    await entry(itemId, '50', '300');
    await replace(id, '100', '550');
    // 100 a 5.5 + 50 a 6 = 850 / 150 = 5.66667. Con otras existencias, el valor de partida sale
    // del promedio guardado a 4 decimales (800 / 150 = 5.3333), así que el resultado puede
    // quedar a ±0,0001: es el aviso que muestra la vista previa en ese caso.
    const after = await balance(itemId);
    expect(after.qty).toBe('150.000');
    expect(Math.abs(Number(after.avgCost) - 5.66667)).toBeLessThanOrEqual(0.0001);
  });

  it('dos reemplazos simultáneos del mismo ingreso: gana uno, el otro sale con 409 y el saldo es el del ganador', async () => {
    const { itemId } = item();
    const id = await entry(itemId, '100', '500');
    const results = await Promise.allSettled([replace(id, '100', '600'), replace(id, '80', '400')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(/ya fue anulado/);
    const live = await prisma.inventoryMovement.findMany({
      where: { itemId, reversalOfId: null, reversals: { none: {} } },
    });
    expect(live).toHaveLength(1);
    const winner = await balance(itemId);
    expect([
      { qty: '100.000', avgCost: '6.0000' },
      { qty: '80.000', avgCost: '5.0000' },
    ]).toContainEqual(winner);
  });

  it('solo un ingreso vivo se reemplaza: una reversa o un ingreso ya reemplazado, no', async () => {
    const { itemId } = item();
    const id = await entry(itemId, '100', '500');
    const { reversal } = await replace(id, '100', '550');
    await expect(replace(id, '100', '500')).rejects.toThrow(/ya fue anulado/);
    await expect(replace(reversal.id, '100', '500')).rejects.toThrow(/anulación/);
  });
});
