import { randomUUID } from 'node:crypto';
import { PrismaClient, Role, type InventoryMovement, type InventoryRefType } from '@prisma/client';
import { Decimal } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { InventoryService } from './inventory.service';
import { qtyRowsOf } from './inventory-recost';

/**
 * cc53 (D-649, D-650) — **recosteo del promedio por fecha**, contra una base real. Cada caso usa
 * productos nuevos (el kardex no exige la fila del producto) y fechas fijas del pasado.
 */
const prisma = new PrismaClient();
const inventory = new InventoryService(
  prisma as unknown as PrismaService,
  { ROOFING_THICKNESS_TOLERANCE_MM: '0.02' } as Env,
  new AuditService(prisma as unknown as PrismaService),
);

let businessLineId = '';
let adminId = '';

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
});

afterAll(async () => {
  await prisma.$disconnect();
});

interface Move {
  type: 'IN' | 'OUT';
  qty: string;
  unitCost?: string;
  totalCost?: string;
  date: string;
  refType?: InventoryRefType;
  refId?: string;
}

async function move(itemId: string, m: Move): Promise<InventoryMovement> {
  const movement = await prisma.$transaction((tx) =>
    inventory.record(tx, {
      businessLineId,
      itemType: 'PRODUCT',
      itemId,
      type: m.type,
      qty: m.qty,
      unit: 'NIU',
      unitCost: m.unitCost,
      totalCost: m.totalCost,
      refType: m.refType ?? (m.type === 'IN' ? 'PURCHASE' : 'SALE'),
      refId: m.refId,
      actorId: adminId,
      operationDate: m.date,
      confirmBackdate: true,
    }),
  );
  if (!movement) throw new Error('La línea de prueba no lleva stock');
  return movement;
}

/** Costo efectivo (grabado ± recosteos) de un movimiento. */
async function effective(id: bigint): Promise<string> {
  const m = await prisma.inventoryMovement.findUniqueOrThrow({ where: { id } });
  const adj = await prisma.inventoryMovement.aggregate({
    where: { recostOfId: id },
    _sum: { totalCost: true },
  });
  const extra = new Decimal(adj._sum.totalCost?.toString() ?? '0');
  const total = new Decimal(m.totalCost.toString());
  return (m.type === 'OUT' ? total.minus(extra) : total.plus(extra)).toFixed(4);
}

/** Valor del kardex por la suma de sus filas (la cuenta de la vista Promedio). */
async function kardexValue(itemId: string): Promise<Decimal> {
  const rows = await prisma.inventoryMovement.findMany({ where: { itemId } });
  return rows.reduce((s, r) => {
    const t = new Decimal(r.totalCost.toString());
    return r.type === 'OUT' ? s.minus(t) : s.plus(t);
  }, new Decimal(0));
}

async function balanceOf(itemId: string) {
  const b = await prisma.inventoryBalance.findFirstOrThrow({ where: { itemId } });
  return { qty: b.qty.toString(), avg: b.avgCost.toString() };
}

describe('cc53 (D-649): salida atrasada', () => {
  it('toma el promedio vigente a su fecha, no el de hoy (sin bloqueo de D-648)', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    await move(itemId, { type: 'IN', qty: '10', unitCost: '20', date: '2026-08-20' });
    const out = await move(itemId, { type: 'OUT', qty: '4', date: '2026-08-10' });
    expect(out.totalCost.toString()).toBe('40');
    // Saldo: 16 u por 260 (300 − 40).
    expect(await balanceOf(itemId)).toEqual({ qty: '16', avg: '16.25' });
    expect(
      await prisma.inventoryMovement.count({ where: { itemId, recostOfId: { not: null } } }),
    ).toBe(0);
  });

  it('dos salidas el mismo día toman el promedio en su orden de registro', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    await move(itemId, { type: 'IN', qty: '10', unitCost: '30', date: '2026-08-20' });
    const a = await move(itemId, { type: 'OUT', qty: '4', date: '2026-08-05' });
    const b = await move(itemId, { type: 'OUT', qty: '6', date: '2026-08-05' });
    expect(a.totalCost.toString()).toBe('40');
    expect(b.totalCost.toString()).toBe('60');
    expect(await balanceOf(itemId)).toEqual({ qty: '10', avg: '30' });
  });
});

describe('cc53 (D-649): recalcular hacia adelante', () => {
  it('una entrada atrasada recostea la salida posterior con un ADJUST en su fecha y su ref', async () => {
    const itemId = randomUUID();
    const dispatchRef = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    const out = await move(itemId, {
      type: 'OUT',
      qty: '4',
      date: '2026-08-10',
      refId: dispatchRef,
    });
    expect(out.totalCost.toString()).toBe('40');
    // Llega tarde una compra del 05/08: a la fecha de la salida el promedio era 25.
    await move(itemId, { type: 'IN', qty: '10', unitCost: '40', date: '2026-08-05' });
    const recost = await prisma.inventoryMovement.findMany({ where: { recostOfId: out.id } });
    expect(recost).toHaveLength(1);
    expect(recost[0]).toMatchObject({ type: 'ADJUST', refType: 'SALE', refId: dispatchRef });
    expect(recost[0]?.totalCost.toString()).toBe('-60');
    expect(recost[0]?.operationDate.toISOString().slice(0, 10)).toBe('2026-08-10');
    expect(await effective(out.id)).toBe('100.0000');
    // La fila original no cambió (append-only).
    expect(
      (
        await prisma.inventoryMovement.findUniqueOrThrow({ where: { id: out.id } })
      ).totalCost.toString(),
    ).toBe('40');
    // Saldo: 16 u por 400 (500 − 100).
    expect(await balanceOf(itemId)).toEqual({ qty: '16', avg: '25' });
    expect((await kardexValue(itemId)).toFixed(4)).toBe('400.0000');
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'inventory.recost', entity: 'dispatches', entityId: dispatchRef },
    });
    expect(audit).not.toBeNull();
  });

  it('una reversa atrasada recostea, y revertir una salida recosteada devuelve su costo efectivo', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    const late = await move(itemId, { type: 'IN', qty: '10', unitCost: '40', date: '2026-08-05' });
    const out = await move(itemId, { type: 'OUT', qty: '4', date: '2026-08-10' });
    expect(out.totalCost.toString()).toBe('100');
    // Se anula la compra del 05/08 con su misma fecha: la salida del 10/08 vuelve a 10.
    await prisma.$transaction((tx) =>
      inventory.reverse(tx, late.id, adminId, 'compra mal cargada', '2026-08-05', true),
    );
    expect(await effective(out.id)).toBe('40.0000');
    expect(await balanceOf(itemId)).toEqual({ qty: '6', avg: '10' });
    // Anular la salida devuelve los 40 efectivos, no los 100 grabados.
    const back = await prisma.$transaction((tx) =>
      inventory.reverse(tx, out.id, adminId, 'devuelta'),
    );
    expect(back.totalCost.toString()).toBe('40');
    expect(await balanceOf(itemId)).toEqual({ qty: '10', avg: '10' });
  });

  it('un ajuste de recosteo no se anula por separado', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    const out = await move(itemId, { type: 'OUT', qty: '4', date: '2026-08-10' });
    await move(itemId, { type: 'IN', qty: '10', unitCost: '40', date: '2026-08-05' });
    const recost = await prisma.inventoryMovement.findFirstOrThrow({
      where: { recostOfId: out.id },
    });
    await expect(
      prisma.$transaction((tx) => inventory.reverse(tx, recost.id, adminId, 'x')),
    ).rejects.toThrow('recosteo');
  });
});

describe('cc53 (D-649): cadena material → producción → producto terminado → despacho', () => {
  it('el costo corregido del consumo llega al producto y a su venta', async () => {
    const material = randomUUID();
    const finished = randomUUID();
    const report = randomUUID();
    await move(material, { type: 'IN', qty: '100', unitCost: '1', date: '2026-08-01' });
    const consumption = await move(material, {
      type: 'OUT',
      qty: '50',
      date: '2026-08-10',
      refType: 'PRODUCTION',
      refId: report,
    });
    // El reporte de producción ingresa el producto al costo de lo consumido (50).
    const made = await move(finished, {
      type: 'IN',
      qty: '5',
      unitCost: '10',
      date: '2026-08-10',
      refType: 'PRODUCTION',
      refId: report,
    });
    const sale = await move(finished, { type: 'OUT', qty: '2', date: '2026-08-15' });
    expect(sale.totalCost.toString()).toBe('20');
    // Compra atrasada del material, del 05/08: el promedio a la fecha del consumo pasa a 2.
    await move(material, { type: 'IN', qty: '100', unitCost: '3', date: '2026-08-05' });
    expect(await effective(consumption.id)).toBe('100.0000');
    expect(await effective(made.id)).toBe('100.0000');
    expect(await effective(sale.id)).toBe('40.0000');
    expect(await balanceOf(material)).toEqual({ qty: '150', avg: '2' });
    expect(await balanceOf(finished)).toEqual({ qty: '3', avg: '20' });
  });
});

describe('cc53 (D-649): la estructura del caso de cc52, con cifras de muestra (cc54)', () => {
  it('las salidas de abril grabadas después de la compra salen a su fecha', async () => {
    const itemId = randomUUID();
    await move(itemId, {
      type: 'IN',
      qty: '100',
      totalCost: '1000.0000',
      unitCost: '10.0000',
      date: '2026-03-02',
    });
    await move(itemId, { type: 'OUT', qty: '60', date: '2026-03-30' });
    const reversed = await move(itemId, { type: 'OUT', qty: '5', date: '2026-04-17' });
    await prisma.$transaction((tx) =>
      inventory.reverse(tx, reversed.id, adminId, 'anulada', '2026-04-17', true),
    );
    await move(itemId, { type: 'OUT', qty: '4', date: '2026-04-24' });
    // El 06/05 entra la compra; recién después se graban las salidas de abril, en el orden
    // de cc52: siete, la de mayo y la del 28/04 al final.
    await move(itemId, { type: 'IN', qty: '70', unitCost: '9.20', date: '2026-05-06' });
    const lateMonth: bigint[] = [];
    const late = async (qty: string, date: string) =>
      (await move(itemId, { type: 'OUT', qty, date })).id;
    for (const [qty, date] of [
      ['2', '2026-04-02'],
      ['1', '2026-04-06'],
      ['10', '2026-04-06'],
      ['1', '2026-04-06'],
      ['9', '2026-04-09'],
      ['1', '2026-04-13'],
      ['1', '2026-04-14'],
    ] as const) {
      lateMonth.push(await late(qty, date));
    }
    const nextMonth = await move(itemId, { type: 'OUT', qty: '25', date: '2026-05-06' });
    lateMonth.push(await late('10', '2026-04-28'));

    // Antes (registro al promedio del momento): abril 35 × 9.4717, mayo 25 × 9.4717.
    const oldLate = new Decimal('35').times('9.4717');
    const oldNext = new Decimal('25').times('9.4717');
    let newLate = new Decimal(0);
    for (const id of lateMonth) newLate = newLate.plus(await effective(id));
    expect(newLate.minus(oldLate).toFixed(2)).toBe('18.49');
    expect(new Decimal(await effective(nextMonth.id)).minus(oldNext).toFixed(2)).toBe('-6.51');
    // Inventario: 46 u. Antes, 46 × 9.4717.
    const value = await kardexValue(itemId);
    expect(value.minus(new Decimal('46').times('9.4717')).toFixed(2)).toBe('-11.98');
    expect(await balanceOf(itemId)).toEqual({ qty: '46', avg: '9.2113' });
  });
});

describe('cc53 (D-649): tope', () => {
  it('encima del tope no ajusta nada y deja «recosteo pendiente» en la auditoría', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    const out = await move(itemId, { type: 'OUT', qty: '4', date: '2026-08-10' });
    const late = await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-05' });
    const outcome = await prisma.$transaction((tx) =>
      inventory.recostForward(tx, [{ itemType: 'PRODUCT', itemId, fromStart: true }], {
        actorId: adminId,
        trigger: late,
        maxRows: 1,
      }),
    );
    expect(outcome.pending).toBe(true);
    expect(await prisma.inventoryMovement.count({ where: { recostOfId: out.id } })).toBe(0);
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'inventory.recost-pending', entity: 'purchases' },
      orderBy: { at: 'desc' },
    });
    expect(audit).toBeNull(); // sin refId: va al producto
    expect(
      await prisma.auditLog.findFirst({
        where: { action: 'inventory.recost-pending', entity: 'products', entityId: itemId },
      }),
    ).not.toBeNull();
  });
});

describe('cc53 (D-652): nada atrasado deja el kardex en negativo', () => {
  async function rejection(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (err) {
      const e = err as { getStatus?: () => number; getResponse?: () => unknown };
      return { status: e.getStatus?.() ?? 500, body: e.getResponse?.() as Record<string, unknown> };
    }
    throw new Error('Se esperaba un rechazo');
  }

  it('una salida atrasada que deja negativo se rechaza con la primera fecha válida', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    await move(itemId, { type: 'OUT', qty: '8', date: '2026-08-05' });
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-10' });
    const r = await rejection(move(itemId, { type: 'OUT', qty: '3', date: '2026-08-03' }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'BACKDATE_NEGATIVE_STOCK', firstValidDate: '2026-08-10' });
    expect(String(r.body.message)).toContain('Puedes hacerlo con fecha 10/08/2026 o posterior');
    expect(r.body.negativeStock).toMatchObject({ operationDate: '2026-08-03', qty: '3.000' });
    expect(await prisma.inventoryMovement.count({ where: { itemId } })).toBe(3);
    // En la fecha sugerida, sí.
    const ok = await move(itemId, { type: 'OUT', qty: '3', date: '2026-08-10' });
    expect(ok.totalCost.toString()).toBe('30');
  });

  it('con 2 sí cabe a su fecha', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    await move(itemId, { type: 'OUT', qty: '8', date: '2026-08-05' });
    const ok = await move(itemId, { type: 'OUT', qty: '2', date: '2026-08-03' });
    expect(ok.totalCost.toString()).toBe('20');
    expect(await balanceOf(itemId)).toEqual({ qty: '0', avg: '0' });
  });

  it('una salida anulada el mismo día no cuenta: re-fechar un despacho a una fecha anterior (D-288)', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    const old = await move(itemId, { type: 'OUT', qty: '10', date: '2026-08-10' });
    await prisma.$transaction((tx) =>
      inventory.reverse(tx, old.id, adminId, 're-fechado', '2026-08-10', true),
    );
    const moved = await move(itemId, { type: 'OUT', qty: '10', date: '2026-08-05' });
    expect(moved.totalCost.toString()).toBe('100');
  });

  it('anular una entrada y reingresarla en su fecha se juzga por el estado final (D-045)', async () => {
    const itemId = randomUUID();
    const entry = await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    const out = await move(itemId, { type: 'OUT', qty: '4', date: '2026-08-10' });
    // Como en D-375: la salida ya se anuló (otro día), así el ingreso entero sigue en stock.
    const back = await prisma.$transaction((tx) =>
      inventory.reverse(tx, out.id, adminId, 'anulada', '2026-08-12', true),
    );
    await prisma.$transaction(async (tx) => {
      await inventory.reverse(tx, entry.id, adminId, 'costo corregido', '2026-08-01', true, {
        reentry: true,
      });
      await inventory.record(tx, {
        businessLineId,
        itemType: 'PRODUCT',
        itemId,
        type: 'IN',
        qty: '10',
        unit: 'NIU',
        unitCost: '20',
        refType: 'PURCHASE',
        actorId: adminId,
        operationDate: '2026-08-01',
        confirmBackdate: true,
      });
    });
    expect(await effective(out.id)).toBe('80.0000');
    expect(await effective(back.id)).toBe('80.0000');
    expect(await balanceOf(itemId)).toEqual({ qty: '10', avg: '20' });
  });

  it('anular con fecha atrasada una entrada que ya salió se rechaza', async () => {
    const itemId = randomUUID();
    const entry = await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    await move(itemId, { type: 'OUT', qty: '6', date: '2026-08-05' });
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-10' });
    const r = await rejection(
      prisma.$transaction((tx) =>
        inventory.reverse(tx, entry.id, adminId, 'mal cargada', '2026-08-01', true),
      ),
    );
    expect(r.body).toMatchObject({ code: 'BACKDATE_NEGATIVE_STOCK', firstValidDate: '2026-08-10' });
    // cc54 (P3-3): el texto dice qué entrada se saca y por qué.
    expect(String(r.body.message)).toContain(
      'Sacar del kardex la entrada del 01/08/2026 («mal cargada»)',
    );
  });

  it('cc54 (P2-1): sin acuse de retrofecha, el rechazo es D-652 y no el diálogo de confirmar', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    await move(itemId, { type: 'OUT', qty: '8', date: '2026-08-05' });
    const r = await rejection(
      prisma.$transaction((tx) =>
        inventory.record(tx, {
          businessLineId,
          itemType: 'PRODUCT',
          itemId,
          type: 'OUT',
          qty: '3',
          unit: 'NIU',
          refType: 'SALE',
          actorId: adminId,
          operationDate: '2026-08-03',
        }),
      ),
    );
    expect(r.body).toMatchObject({ code: 'BACKDATE_NEGATIVE_STOCK' });
    // Si cabe, sigue pidiendo el acuse de siempre (D-124).
    const ok = await rejection(
      prisma.$transaction((tx) =>
        inventory.record(tx, {
          businessLineId,
          itemType: 'PRODUCT',
          itemId,
          type: 'OUT',
          qty: '2',
          unit: 'NIU',
          refType: 'SALE',
          actorId: adminId,
          operationDate: '2026-08-03',
        }),
      ),
    );
    expect(ok.body).toMatchObject({ code: 'BACKDATE_OUT_OF_ORDER' });
  });

  it('cc54 (P2-4): qtyRowsOf lee el kardex del ítem en una sola consulta', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    const out = await move(itemId, { type: 'OUT', qty: '4', date: '2026-08-05' });
    await prisma.$transaction((tx) =>
      inventory.reverse(tx, out.id, adminId, 'anulada', '2026-08-05', true),
    );
    await move(itemId, { type: 'IN', qty: '5', unitCost: '30', date: '2026-08-03' }); // recostea
    const queries: string[] = [];
    const counting = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    counting.$on('query', (e) => queries.push(e.query));
    try {
      const rows = await counting.$transaction(async (tx) => {
        queries.length = 0;
        return qtyRowsOf(tx, { itemType: 'PRODUCT', itemId });
      });
      const selects = queries.filter((q) => q.startsWith('SELECT'));
      expect(selects).toHaveLength(1);
      // El par del 05 se cancela; el recosteo no cuenta.
      expect(rows.map((x) => [x.date, x.delta.toString()])).toEqual([
        ['2026-08-01', '10'],
        ['2026-08-03', '5'],
      ]);
    } finally {
      await counting.$disconnect();
    }
  });
});

describe('cc55 (D-665, E-01 de audit-01): recostear entradas ya registradas', () => {
  const recost = (entries: { movementId: bigint; addPen: string }[]) =>
    prisma.$transaction((tx) =>
      inventory.recostEntries(
        tx,
        entries.map((e) => ({ movementId: e.movementId, addPen: new Decimal(e.addPen) })),
        { actorId: adminId, note: 'Cierre de prueba (D-665)' },
      ),
    );

  it('con el producto ya despachado el mismo día, el costo agregado llega a la salida', async () => {
    const itemId = randomUUID();
    const entry = await move(itemId, {
      type: 'IN',
      qty: '10',
      unitCost: '10',
      date: '2026-08-01',
      refType: 'PRODUCTION',
    });
    const out = await move(itemId, { type: 'OUT', qty: '10', date: '2026-08-01' });
    expect(out.totalCost.toString()).toBe('100');

    await recost([{ movementId: entry.id, addPen: '30' }]);
    expect(await effective(entry.id)).toBe('130.0000');
    expect(await effective(out.id)).toBe('130.0000');
    const adjusts = await prisma.inventoryMovement.findMany({
      where: { itemId, recostOfId: { not: null } },
    });
    expect(adjusts.every((a) => a.notes === 'Cierre de prueba (D-665)')).toBe(true);
    // El kardex queda en cero de cantidad y de valor.
    expect((await balanceOf(itemId)).qty).toBe('0');
    expect((await kardexValue(itemId)).toFixed(4)).toBe('0.0000');
  });

  it('con dos salidas posteriores, se reparte en proporción a lo que cada una se llevó', async () => {
    const itemId = randomUUID();
    const entry = await move(itemId, {
      type: 'IN',
      qty: '10',
      unitCost: '10',
      date: '2026-08-01',
      refType: 'PRODUCTION',
    });
    const a = await move(itemId, { type: 'OUT', qty: '4', date: '2026-08-03' });
    const b = await move(itemId, { type: 'OUT', qty: '6', date: '2026-08-06' });
    await recost([{ movementId: entry.id, addPen: '20' }]);
    expect(await effective(a.id)).toBe('48.0000');
    expect(await effective(b.id)).toBe('72.0000');
  });

  it('con saldo que queda, lo que no salió se queda en el saldo', async () => {
    const itemId = randomUUID();
    const entry = await move(itemId, {
      type: 'IN',
      qty: '10',
      unitCost: '10',
      date: '2026-08-01',
      refType: 'PRODUCTION',
    });
    const out = await move(itemId, { type: 'OUT', qty: '5', date: '2026-08-02' });
    await recost([{ movementId: entry.id, addPen: '10' }]);
    expect(await effective(out.id)).toBe('55.0000');
    expect(await balanceOf(itemId)).toEqual({ qty: '5', avg: '11' });
  });

  it('solo entradas: una salida se rechaza sin escribir nada', async () => {
    const itemId = randomUUID();
    await move(itemId, { type: 'IN', qty: '10', unitCost: '10', date: '2026-08-01' });
    const out = await move(itemId, { type: 'OUT', qty: '1', date: '2026-08-02' });
    await expect(recost([{ movementId: out.id, addPen: '5' }])).rejects.toThrow(
      /no es una entrada/,
    );
    expect(
      await prisma.inventoryMovement.count({ where: { itemId, recostOfId: { not: null } } }),
    ).toBe(0);
  });
});

describe('cc57 (A-01 de audit-01): recosteo de la madre con una hija ya recosteada (D-045)', () => {
  it('el cambio de la madre llega entero a las hijas vivas, no al ingreso anulado', async () => {
    const mother = randomUUID();
    const child1 = randomUUID();
    const child2 = randomUUID();
    const split = randomUUID();
    await move(mother, { type: 'IN', qty: '100', unitCost: '1', date: '2026-08-01' });
    const out = await move(mother, {
      type: 'OUT',
      qty: '100',
      date: '2026-08-10',
      refType: 'SPLIT',
      refId: split,
    });
    const h1 = await move(child1, {
      type: 'IN',
      qty: '50',
      unitCost: '1',
      date: '2026-08-10',
      refType: 'SPLIT',
      refId: split,
    });
    await move(child2, {
      type: 'IN',
      qty: '50',
      unitCost: '1',
      date: '2026-08-10',
      refType: 'SPLIT',
      refId: split,
    });
    // «Editar bobina» sobre la hija 1 (D-045): reversa de su ingreso y reingreso con el mismo ref.
    const h1Again = await prisma.$transaction(async (tx) => {
      const back = await inventory.reverse(tx, h1.id, adminId, 'recosteo', '2026-08-10', true, {
        reentry: true,
      });
      return inventory.record(tx, {
        businessLineId,
        itemType: 'PRODUCT',
        itemId: child1,
        type: 'IN',
        qty: '50',
        unit: 'NIU',
        unitCost: '1',
        totalCost: back.totalCost.toFixed(4),
        refType: 'SPLIT',
        refId: split,
        actorId: adminId,
        operationDate: '2026-08-10',
        confirmBackdate: true,
      });
    });
    if (!h1Again) throw new Error('sin reingreso');
    // Llega tarde una compra de la madre del 05/08: a la fecha del partido el promedio es 2.
    await move(mother, { type: 'IN', qty: '100', unitCost: '3', date: '2026-08-05' });
    expect(await effective(out.id)).toBe('200.0000');
    // Las dos hijas vivas se llevan los 100 de más, mitad y mitad; el ingreso anulado nada.
    const c1 = await balanceValue(child1);
    const c2 = await balanceValue(child2);
    expect(c2).toBe('100.0000');
    expect(c1).toBe('100.0000');
    expect((await kardexValue(child1)).toFixed(4)).toBe('100.0000');
  });
});

/** El valor del saldo de un ítem (cantidad × promedio). */
async function balanceValue(itemId: string): Promise<string> {
  const b = await prisma.inventoryBalance.findFirstOrThrow({ where: { itemId } });
  return new Decimal(b.qty.toString()).times(b.avgCost.toString()).toFixed(4);
}

describe('cc57 (A-06 de audit-01): la vista del kardex al pasar por cero', () => {
  it('el residuo de valor de una salida que agota el ítem no pasa a la entrada siguiente', async () => {
    const itemId = randomUUID();
    await move(itemId, {
      type: 'IN',
      qty: '3',
      unitCost: '3.3333',
      totalCost: '10.0000',
      date: '2026-08-01',
    });
    // Sale todo al promedio a 4 decimales: 3 × 3.3333 = 9.9999, quedan 0.0001 sin cantidad.
    await move(itemId, { type: 'OUT', qty: '3', date: '2026-08-02' });
    await move(itemId, { type: 'IN', qty: '1', unitCost: '5', date: '2026-08-03' });
    const page = await inventory.findMovements(
      { itemType: 'PRODUCT', itemId, pageSize: 50 } as never,
      true,
    );
    const last = page.items.find((r) => r.operationDate === '2026-08-03');
    expect(last?.balanceTotalCost).toBe('5.0000');
    expect(await balanceOf(itemId)).toEqual({ qty: '1', avg: '5' });
    // Con «desde» después del paso por cero, la apertura tampoco arrastra el residuo.
    const from = await inventory.findMovements(
      { itemType: 'PRODUCT', itemId, from: '2026-08-03', pageSize: 50 } as never,
      true,
    );
    expect(from.items[0]?.balanceTotalCost).toBe('5.0000');
  });
});
