import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  createCoilSplitSchema,
  createFinishSchema,
  createPurchaseSchema,
  createSupplierSchema,
  Decimal,
  reverseMovementSchema,
  updateCoilSchema,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { FinishesService } from '../finishes/finishes.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { InventoryValuationService } from '../reports/inventory-valuation.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { CoilOperationsService } from './coil-operations.service';

/**
 * D-608 (cc46) — **el kerf y el borde del partido interno con costo, contra la base.**
 *
 * La madre sale con los kilos partidos al promedio vigente; las hijas entran con ese valor entero
 * repartido por kilo (la más pesada se lleva el redondeo), la misma regla que D-597 en la
 * recepción de corte. Antes las hijas entraban al promedio de la madre y el valor de `kerfLossKg`
 * desaparecía del inventario. Se prueba el partido con y sin borde, el redondeo, la bobina en
 * dólares, la reversa (RF-16) y el inventario valorizado.
 */
// `pg-boss` es ESM y Jest no lo transforma; con `JOBS_ENABLED=false` las colas nunca arrancan.
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(5 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let purchases: PurchasesService;
let operations: CoilOperationsService;
let valuation: InventoryValuationService;
let admin: RequestUser;
let supplierId = '';
let galvanizedId = '';

const letters = (n: number) =>
  Array.from({ length: n }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join(
    '',
  );
const digits = (n: number) =>
  Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');

beforeAll(async () => {
  assertTestDatabase();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  prisma = moduleRef.get(PrismaService);
  purchases = moduleRef.get(PurchasesService);
  operations = moduleRef.get(CoilOperationsService);
  valuation = moduleRef.get(InventoryValuationService);
  const suppliers = moduleRef.get(SuppliersService);
  const finishes = moduleRef.get(FinishesService);

  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  admin = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: Role.ADMINISTRADOR,
    mustChangePassword: false,
    sessionId: randomUUID(),
  };
  supplierId = (
    await suppliers.create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name: 'Proveedor de bobinas cc46',
        creditDays: 0,
        providesCuttingService: false,
      }),
    )
  ).id;
  galvanizedId = (
    await finishes.create(
      admin,
      createFinishSchema.parse({
        code: `G${letters(5)}`,
        name: 'Galvanizado cc46',
        densityFactor: '7.85',
        kind: 'GALVANIZADO',
        businessLine: 'drywall',
      }),
    )
  ).id;
});

afterAll(async () => {
  await moduleRef?.close();
});

const UNIT_PRICE = '4.1234';

/** Una bobina de drywall de 2 000 kg y 1 220 mm a 4.1234 por kg, recibida y abierta. */
async function openCoil(currency: 'PEN' | 'USD' = 'PEN'): Promise<string> {
  const purchase = await purchases.create(
    admin,
    createPurchaseSchema.parse({
      supplierId,
      docType: 'FACTURA',
      series: 'F001',
      number: digits(8),
      issueDate: businessToday(),
      currency,
      ...(currency === 'USD' ? { exchangeRate: '3.7500' } : {}),
      paymentTerms: 'CONTADO',
      businessLine: 'drywall',
      type: 'COIL',
      items: [
        {
          description: 'Bobina cc46',
          qty: '2000',
          unit: 'KGM',
          unitPrice: UNIT_PRICE,
          finishId: galvanizedId,
          widthMm: '1220',
          thicknessMm: '0.45',
          coilStatus: 'OPEN',
        },
      ],
    }),
  );
  await purchases.receive(admin, purchase.id);
  return (await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } })).id;
}

function split(
  motherId: string,
  children: { widthMm: string; count: number }[],
  kerfLossMm: string,
  splitWeightKg?: string,
) {
  return operations.split(
    admin,
    motherId,
    createCoilSplitSchema.parse({
      kerfLossMm,
      children,
      ...(splitWeightKg === undefined ? {} : { splitWeightKg }),
    }),
  );
}

async function splitMovements(motherId: string) {
  const record = await prisma.coilSplit.findFirstOrThrow({
    where: { parentCoilId: motherId, status: 'ACTIVE' },
  });
  const movements = await prisma.inventoryMovement.findMany({
    where: { refType: 'SPLIT', refId: record.id, reversalOfId: null, reversals: { none: {} } },
    orderBy: { id: 'asc' },
  });
  const out = movements.find((m) => m.itemId === motherId && m.type === 'OUT');
  const ins = movements.filter((m) => m.type === 'IN');
  if (!out) throw new Error('El partido no dejó la salida de la madre');
  return { record, out, ins };
}

const sum = (values: Decimal[]) => values.reduce((acc, v) => acc.plus(v), new Decimal(0));
const dec = (v: { toString(): string }) => new Decimal(v.toString());

async function balance(itemId: string) {
  return prisma.inventoryBalance.findUniqueOrThrow({
    where: { itemType_itemId: { itemType: 'COIL', itemId } },
  });
}

describe('D-608 — el kerf y el borde del partido interno quedan en el costo de las hijas', () => {
  it('con borde: la suma de las hijas iguala la salida de la madre y el documento sube igual', async () => {
    const motherId = await openCoil();
    await split(
      motherId,
      [
        { widthMm: '600.00', count: 1 },
        { widthMm: '560.00', count: 1 },
      ],
      '20.00',
    );
    const { record, out, ins } = await splitMovements(motherId);

    // 2 000 kg × S/ 4.1234 = S/ 8 246.80 salieron de la madre.
    expect(out.qty.toFixed(3)).toBe('2000.000');
    expect(out.totalCost.toFixed(4)).toBe('8246.8000');
    // Hijas: 2 000 × 600/1 220 = 983.607 kg y 2 000 × 1 160/1 220 − 983.607 = 918.032 kg; el
    // resto (98.361 kg: 20 mm de kerf más 40 mm de borde) ya no se pierde.
    expect(ins.map((m) => m.qty.toFixed(3))).toEqual(['983.607', '918.032']);
    expect(record.kerfLossKg.toFixed(3)).toBe('98.361');

    const values = ins.map((m) => dec(m.totalCost));
    expect(sum(values).toFixed(4)).toBe(out.totalCost.toFixed(4));
    // Al promedio de la madre las hijas valían 1 901.639 × 4.1234 = 7 841.22; los 405.58 del
    // kerf y el borde se repartieron por kilo.
    const atMotherCost = sum(ins.map((m) => dec(m.qty).times(UNIT_PRICE)));
    expect(dec(out.totalCost).minus(atMotherCost).toFixed(2)).toBe('405.58');
    // La liviana lleva su parte truncada a 4 decimales; la pesada, el resto.
    const totalKg = sum(ins.map((m) => dec(m.qty)));
    const light = ins[1];
    if (!light) throw new Error('Faltan hijas');
    expect(dec(light.totalCost).toFixed(4)).toBe(
      dec(out.totalCost)
        .times(dec(light.qty))
        .div(totalKg)
        .toDecimalPlaces(4, Decimal.ROUND_DOWN)
        .toFixed(4),
    );

    // El costo por kilo sube y los kilos no cambian.
    for (const m of ins) {
      const b = await balance(m.itemId);
      expect(b.qty.toFixed(3)).toBe(m.qty.toFixed(3));
      expect(dec(b.avgCost).gt(UNIT_PRICE)).toBe(true);
      expect(b.avgCost.toFixed(4)).toBe(m.unitCost.toFixed(4));
    }
    // El documento sube en la misma proporción: 4.1234 × 2 000 / 1 901.639 = 4.3367. En soles y
    // sin landed cost, documento y kardex dicen lo mismo a 4 decimales (lo que lee D-164 al
    // valorizar un sobrante con el saldo en cero).
    const children = await prisma.coil.findMany({ where: { splitId: record.id } });
    expect(children).toHaveLength(2);
    for (const c of children) {
      expect(c.unitCostPerKg.toFixed(4)).toBe('4.3367');
      const b = await balance(c.id);
      expect(
        dec(b.avgCost)
          .minus(dec(c.unitCostPerKg).times(c.exchangeRate.toString()))
          .abs()
          .lte('0.0001'),
      ).toBe(true);
      const entry = ins.find((m) => m.itemId === c.id);
      expect(c.totalCostPen.toFixed(4)).toBe(entry?.totalCost.toFixed(4));
    }
    // La madre quedó en cero y se cerró sola (D-360).
    const mother = await balance(motherId);
    expect(mother.qty.toFixed(3)).toBe('0.000');

    // La auditoría deja el valor repartido.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'coils.split', entityId: motherId },
      orderBy: { at: 'desc' },
    });
    expect((audit.after as { kerfValuePen?: string }).kerfValuePen).toBe(
      dec(out.totalCost).times(dec(record.kerfLossKg)).div('2000').toFixed(4),
    );
  });

  it('sin borde ni kerf: las hijas quedan al promedio de la madre, como antes', async () => {
    const motherId = await openCoil();
    await split(motherId, [{ widthMm: '610.00', count: 2 }], '0.00', '1000');
    const { record, out, ins } = await splitMovements(motherId);
    expect(record.kerfLossKg.toFixed(3)).toBe('0.000');
    expect(ins.map((m) => m.qty.toFixed(3))).toEqual(['500.000', '500.000']);
    expect(sum(ins.map((m) => dec(m.totalCost))).toFixed(4)).toBe(out.totalCost.toFixed(4));
    for (const m of ins) expect(m.unitCost.toFixed(4)).toBe(UNIT_PRICE);
    const children = await prisma.coil.findMany({ where: { splitId: record.id } });
    for (const c of children) expect(c.unitCostPerKg.toFixed(4)).toBe(UNIT_PRICE);
    // Un partido parcial deja a la madre con su resto y su promedio.
    const mother = await balance(motherId);
    expect(mother.qty.toFixed(3)).toBe('1000.000');
    expect(mother.avgCost.toFixed(4)).toBe(UNIT_PRICE);
  });

  it('redondeo: importes que no dividen exacto y empate de pesos (la primera se lleva el resto)', async () => {
    const motherId = await openCoil();
    // 1 000 kg en tres hijas de 400 mm sobre 1 220: 327.869 kg cada una y 16.393 kg de borde.
    await split(motherId, [{ widthMm: '400.00', count: 3 }], '0.00', '1000');
    const { out, ins } = await splitMovements(motherId);
    expect(ins.map((m) => m.qty.toFixed(3))).toEqual(['327.869', '327.869', '327.869']);
    expect(out.totalCost.toFixed(4)).toBe('4123.4000');
    // 4 123.40 / 3 no es exacto: cada parte se trunca a 4.1234 × … y la primera completa.
    const share = dec(out.totalCost).div(3).toDecimalPlaces(4, Decimal.ROUND_DOWN);
    expect(ins[1]?.totalCost.toFixed(4)).toBe(share.toFixed(4));
    expect(ins[2]?.totalCost.toFixed(4)).toBe(share.toFixed(4));
    expect(ins[0]?.totalCost.toFixed(4)).toBe(dec(out.totalCost).minus(share.times(2)).toFixed(4));
    expect(sum(ins.map((m) => dec(m.totalCost))).toFixed(4)).toBe(out.totalCost.toFixed(4));
  });

  it('en una bobina en USD el kardex reparte en soles y el documento sube en dólares', async () => {
    const motherId = await openCoil('USD');
    await split(
      motherId,
      [
        { widthMm: '600.00', count: 1 },
        { widthMm: '560.00', count: 1 },
      ],
      '20.00',
    );
    const { record, out, ins } = await splitMovements(motherId);
    // La compra entra por S/ 30 925.50 (2 000 kg × 4.1234 USD × 3.75), promedio 15.4628 a 4
    // decimales: los 2 000 kg salen por S/ 30 925.60.
    expect(out.totalCost.toFixed(4)).toBe('30925.6000');
    expect(sum(ins.map((m) => dec(m.totalCost))).toFixed(4)).toBe(out.totalCost.toFixed(4));
    const children = await prisma.coil.findMany({ where: { splitId: record.id } });
    for (const c of children) {
      expect(c.currency).toBe('USD');
      expect(c.unitCostPerKg.toFixed(4)).toBe('4.3367');
      const entry = ins.find((m) => m.itemId === c.id);
      expect(c.totalCostPen.toFixed(4)).toBe(entry?.totalCost.toFixed(4));
    }
  });

  it('la reversa del partido devuelve a la madre exacto, kerf y borde incluidos (RF-16)', async () => {
    const motherId = await openCoil();
    const before = await balance(motherId);
    await split(
      motherId,
      [
        { widthMm: '600.00', count: 1 },
        { widthMm: '560.00', count: 1 },
      ],
      '20.00',
      '1500',
    );
    const { record, ins } = await splitMovements(motherId);

    await operations.revertSplit(
      admin,
      record.id,
      reverseMovementSchema.parse({ reason: 'Prueba de reversa del borde cc46' }),
    );

    const mother = await balance(motherId);
    expect(mother.qty.toFixed(3)).toBe(before.qty.toFixed(3));
    expect(mother.avgCost.toFixed(4)).toBe(before.avgCost.toFixed(4));
    expect(dec(mother.qty).times(dec(mother.avgCost)).toFixed(4)).toBe(
      dec(before.qty).times(dec(before.avgCost)).toFixed(4),
    );
    for (const m of ins) {
      const b = await balance(m.itemId);
      expect(b.qty.toFixed(3)).toBe('0.000');
      const reversal = await prisma.inventoryMovement.findFirstOrThrow({
        where: { reversalOfId: m.id },
      });
      expect(reversal.totalCost.toFixed(4)).toBe(m.totalCost.toFixed(4));
    }
    const reverted = await prisma.coilSplit.findUniqueOrThrow({ where: { id: record.id } });
    expect(reverted.status).toBe('REVERTED');
  });

  it('el inventario valorizado no cambia con el partido (solo el redondeo del promedio)', async () => {
    const motherId = await openCoil();
    const totalOf = async () =>
      dec((await valuation.valuation({ businessLine: 'drywall' })).totals.totalValuePen);
    const before = await totalOf();
    await split(
      motherId,
      [
        { widthMm: '600.00', count: 1 },
        { widthMm: '560.00', count: 1 },
      ],
      '20.00',
      '1500',
    );
    const after = await totalOf();
    const { record, out, ins } = await splitMovements(motherId);
    // El valorizado es Σ kilos × promedio a 4 decimales: cada hija puede mover medio diezmilésimo
    // por kilo. Sin D-608 habría bajado el valor del kerf y el borde entero.
    const bound = sum(ins.map((m) => dec(m.qty))).times('0.00005');
    expect(after.minus(before).abs().lte(bound)).toBe(true);
    const lostBefore608 = dec(out.totalCost).times(dec(record.kerfLossKg)).div(dec(out.qty));
    expect(lostBefore608.gt(bound.times(10))).toBe(true);
    // Revisión cc46 (P2-1): el total de la línea suma toda la base y solo es estable porque
    // `test:db` corre `--runInBand`. Lo mismo, acotado a la madre y sus hijas: el valor no cambia.
    const valueOf = async (ids: string[]) =>
      sum(
        await Promise.all(
          ids.map(async (id) => {
            const b = await balance(id);
            return dec(b.qty).times(dec(b.avgCost));
          }),
        ),
      );
    const family = [motherId, ...ins.map((m) => m.itemId)];
    const motherAfter = await balance(motherId);
    // Antes del partido la madre tenía 2 000 kg a su promedio.
    const familyBefore = dec('2000').times(dec(motherAfter.avgCost));
    expect((await valueOf(family)).minus(familyBefore).abs().lte(bound)).toBe(true);
  });

  it('recostear una hija sin cambiar el costo conserva el valor exacto del reparto (D-045)', async () => {
    const motherId = await openCoil();
    await split(
      motherId,
      [
        { widthMm: '600.00', count: 1 },
        { widthMm: '560.00', count: 1 },
      ],
      '20.00',
    );
    const { record, ins } = await splitMovements(motherId);
    const children = await prisma.coil.findMany({ where: { splitId: record.id } });
    const child = children[0];
    const entry = ins.find((m) => m.itemId === child?.id);
    if (!child || !entry) throw new Error('Falta la hija');

    // El formulario reenvía el mismo costo (con un motivo): reversa y reingreso por el mismo valor.
    await operations.update(
      admin,
      child.id,
      updateCoilSchema.parse({
        unitCostPerKg: child.unitCostPerKg.toFixed(4),
        reason: 'Prueba cc46: mismo costo',
        costReason: 'TYPING_ERROR',
      }),
    );
    const live = await prisma.inventoryMovement.findMany({
      where: { itemType: 'COIL', itemId: child.id, reversalOfId: null, reversals: { none: {} } },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.totalCost.toFixed(4)).toBe(entry.totalCost.toFixed(4));
    const after = await prisma.coil.findUniqueOrThrow({ where: { id: child.id } });
    expect(after.totalCostPen.toFixed(4)).toBe(entry.totalCost.toFixed(4));
    expect(after.unitCostPerKg.toFixed(4)).toBe(child.unitCostPerKg.toFixed(4));

    // Cambiar el costo sí revaloriza (D-045): es una corrección explícita del administrador.
    await operations.update(
      admin,
      child.id,
      updateCoilSchema.parse({
        unitCostPerKg: '4.5000',
        reason: 'Prueba cc46: costo nuevo',
        costReason: 'TYPING_ERROR',
      }),
    );
    const recosted = await prisma.inventoryMovement.findFirstOrThrow({
      where: { itemType: 'COIL', itemId: child.id, reversalOfId: null, reversals: { none: {} } },
    });
    expect(recosted.unitCost.toFixed(4)).toBe('4.5000');
  });
});
