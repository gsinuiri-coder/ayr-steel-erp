import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { InventoryService } from '../inventory/inventory.service';
import { findBlockingLaterMovements } from './purchase-cancel';

/**
 * D-382 (cc15b, P2-2) — el guardrail de la anulación de compras **contra una base real**: qué
 * movimientos posteriores bloquean. En producto terminado, una entrada ajena (otra compra, el
 * reingreso de un reemplazo) ya no; una salida viva, sí; y el filtro va en la consulta, así que
 * varias entradas no tapan una salida que viene después.
 *
 * Ítems y compras son UUID sueltos: el kardex es polimórfico (sin FK al producto ni a la compra).
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

async function entry(itemId: string, purchaseId: string, qty: string, totalCost: string) {
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
      refId: purchaseId,
      actorId,
    }),
  );
  if (!movement) throw new Error('La línea no lleva stock');
  return movement.id;
}

async function sale(itemId: string, qty: string) {
  const movement = await prisma.$transaction((tx) =>
    inventory.record(tx, {
      businessLineId,
      itemType: 'PRODUCT',
      itemId,
      type: 'OUT',
      qty,
      unit: 'NIU',
      refType: 'SALE',
      actorId,
    }),
  );
  if (!movement) throw new Error('La línea no lleva stock');
  return movement.id;
}

/** Los movimientos de la compra, como los lee `PurchasesService.cancel`. */
function ownOf(purchaseId: string) {
  return prisma.inventoryMovement.findMany({
    where: { refType: 'PURCHASE', refId: purchaseId },
    orderBy: { id: 'asc' },
    include: { reversals: { select: { id: true } } },
  });
}

async function blockingFor(purchaseId: string) {
  return findBlockingLaterMovements(prisma, await ownOf(purchaseId));
}

async function balance(itemId: string) {
  const row = await prisma.inventoryBalance.findUniqueOrThrow({
    where: { itemType_itemId: { itemType: 'PRODUCT', itemId } },
    select: { qty: true, avgCost: true },
  });
  return { qty: row.qty.toFixed(3), avgCost: row.avgCost.toFixed(4) };
}

describe('Anulación de compras: qué bloquea (D-382) contra la base', () => {
  it('P2-2: tras reemplazar la compra anterior, la posterior se anula y el saldo cuadra', async () => {
    const itemId = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];
    const firstIn = await entry(itemId, first, '10', '200');
    const secondIn = await entry(itemId, second, '4', '80');
    // Corrección de precio de la primera: su reingreso tiene id mayor que el de la segunda.
    await prisma.$transaction((tx) =>
      inventory.replaceEntry(tx, {
        movementId: firstIn,
        qty: '10',
        unitCost: '27.0000',
        totalCost: '270',
        actorId,
        reason: 'db-spec anulación',
      }),
    );

    expect(await blockingFor(second)).toEqual([]);
    await prisma.$transaction((tx) => inventory.reverse(tx, secondIn, actorId, 'db-spec anular'));
    expect(await balance(itemId)).toEqual({ qty: '10.000', avgCost: '27.0000' });
  });

  it('una salida viva posterior sigue bloqueando', async () => {
    const itemId = randomUUID();
    const purchase = randomUUID();
    await entry(itemId, purchase, '10', '200');
    await entry(itemId, randomUUID(), '4', '80');
    const out = await sale(itemId, '3');

    expect((await blockingFor(purchase)).map((m) => m.id)).toEqual([out]);
  });

  it('una salida ya anulada no bloquea', async () => {
    const itemId = randomUUID();
    const purchase = randomUUID();
    await entry(itemId, purchase, '10', '200');
    const out = await sale(itemId, '3');
    await prisma.$transaction((tx) => inventory.reverse(tx, out, actorId, 'db-spec anulada'));

    expect(await blockingFor(purchase)).toEqual([]);
  });

  it('seis entradas ajenas no tapan una salida viva que viene después (el filtro va en la consulta)', async () => {
    const itemId = randomUUID();
    const purchase = randomUUID();
    await entry(itemId, purchase, '10', '200');
    for (let i = 0; i < 6; i++) await entry(itemId, randomUUID(), '1', '20');
    const out = await sale(itemId, '2');

    expect((await blockingFor(purchase)).map((m) => m.id)).toEqual([out]);
  });
});
