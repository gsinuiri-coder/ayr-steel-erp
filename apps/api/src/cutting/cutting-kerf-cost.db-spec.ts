import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  cancelCuttingOrderSchema,
  createCuttingOrderSchema,
  createFinishSchema,
  createPurchaseSchema,
  createSupplierSchema,
  Decimal,
  receiveCuttingOrderCoilSchema,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { FinishesService } from '../finishes/finishes.service';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { CuttingService } from './cutting.service';

/**
 * D-597 (cc44) — **el kerf del corte tercerizado con costo, contra la base.**
 *
 * La madre sale con sus kilos recibidos al promedio vigente; los flejes entran con ese valor
 * entero repartido por kilo (el más pesado se lleva el redondeo). Antes entraban al promedio de
 * la madre y el valor de `kerfLossKg` desaparecía del inventario. Se prueba la recepción, la
 * reversa (D-052) y la factura del corte que llega después (RF-41).
 */
// `pg-boss` es ESM y Jest no lo transforma; con `JOBS_ENABLED=false` las colas nunca arrancan.
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
jest.setTimeout(5 * 60_000);
process.env.JOBS_ENABLED = 'false';

let moduleRef: TestingModule;
let prisma: PrismaService;
let purchases: PurchasesService;
let cutting: CuttingService;
let admin: RequestUser;
let supplierId = '';
let cutterId = '';
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
  cutting = moduleRef.get(CuttingService);
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
  const supplier = (name: string, providesCuttingService: boolean) =>
    suppliers.create(
      admin,
      createSupplierSchema.parse({
        code: letters(6),
        docType: 'RUC',
        docNumber: `20${digits(9)}`,
        name,
        creditDays: 0,
        providesCuttingService,
      }),
    );
  supplierId = (await supplier('Proveedor de bobinas cc44', false)).id;
  cutterId = (await supplier('Proveedor de corte cc44', true)).id;
  galvanizedId = (
    await finishes.create(
      admin,
      createFinishSchema.parse({
        code: `G${letters(5)}`,
        name: 'Galvanizado cc44',
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

/** Una bobina de drywall de 2 000 kg y 1 220 mm a S/ 4.1234, enviada a cortar en 600 + 560. */
async function sentCoil(
  currency: 'PEN' | 'USD' = 'PEN',
): Promise<{ orderId: string; motherId: string }> {
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
          description: 'Bobina cc44',
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
  const mother = await prisma.coil.findFirstOrThrow({ where: { purchaseId: purchase.id } });
  const order = await cutting.send(
    admin,
    createCuttingOrderSchema.parse({
      supplierId: cutterId,
      coils: [
        {
          coilId: mother.id,
          widthPlanMm: [
            { widthMm: '600.00', stripsCount: 1 },
            { widthMm: '560.00', stripsCount: 1 },
          ],
          expectedKerfLossMm: '20.00',
        },
      ],
    }),
  );
  return { orderId: order.id, motherId: mother.id };
}

/** Recibe 1 500 kg en 600 + 560 con 20 mm de kerf: 60 mm del ancho (kerf + borde) quedan fuera. */
function receive(orderId: string, motherId: string) {
  return cutting.receive(
    admin,
    orderId,
    motherId,
    receiveCuttingOrderCoilSchema.parse({
      receivedWidthsMm: [
        { widthMm: '600.00', stripsCount: 1 },
        { widthMm: '560.00', stripsCount: 1 },
      ],
      receivedWeightKg: '1500',
      kerfLossMm: '20',
    }),
  );
}

async function receptionMovements(orderId: string, motherId: string) {
  const row = await prisma.cuttingOrderCoil.findFirstOrThrow({
    where: { cuttingOrderId: orderId, coilId: motherId },
  });
  const movements = await prisma.inventoryMovement.findMany({
    where: { refType: 'CUTTING', refId: row.id, reversalOfId: null, reversals: { none: {} } },
    orderBy: { id: 'asc' },
  });
  const out = movements.find((m) => m.itemId === motherId && m.type === 'OUT');
  const ins = movements.filter((m) => m.type === 'IN');
  if (!out) throw new Error('La recepción no dejó la salida de la madre');
  return { row, out, ins };
}

const sum = (values: Decimal[]) => values.reduce((acc, v) => acc.plus(v), new Decimal(0));
const dec = (v: { toString(): string }) => new Decimal(v.toString());

async function balance(itemId: string) {
  return prisma.inventoryBalance.findUniqueOrThrow({
    where: { itemType_itemId: { itemType: 'COIL', itemId } },
  });
}

describe('D-597 — el kerf del corte tercerizado queda en el costo de los flejes', () => {
  it('la suma de los flejes iguala el valor que salió de la madre y el más pesado se lleva el redondeo', async () => {
    const { orderId, motherId } = await sentCoil();
    await receive(orderId, motherId);
    const { row, out, ins } = await receptionMovements(orderId, motherId);

    // 1 500 kg × S/ 4.1234 = S/ 6 185.10 salieron de la madre.
    expect(out.qty.toFixed(3)).toBe('1500.000');
    expect(out.totalCost.toFixed(4)).toBe('6185.1000');
    // Flejes: 1 500 × 600/1 220 = 737.705 kg y 1 500 × 1 160/1 220 − 737.705 = 688.525 kg; el
    // resto (73.770 kg de kerf y borde) ya no se pierde.
    expect(ins.map((m) => m.qty.toFixed(3))).toEqual(['737.705', '688.525']);
    expect(row.receivedKerfLossKg?.toFixed(3)).toBe('73.770');

    const values = ins.map((m) => dec(m.totalCost));
    expect(sum(values).toFixed(4)).toBe(out.totalCost.toFixed(4));
    // Al promedio de la madre los flejes valían 1 426.230 × 4.1234 = 5 880.92; los 304.18 del
    // kerf se repartieron por kilo.
    const atMotherCost = sum(ins.map((m) => dec(m.qty).times(UNIT_PRICE)));
    expect(dec(out.totalCost).minus(atMotherCost).toFixed(2)).toBe('304.18');
    // El liviano lleva su parte truncada a 4 decimales; el pesado, el resto.
    const totalKg = sum(ins.map((m) => dec(m.qty)));
    const light = ins[1];
    if (!light) throw new Error('Faltan flejes');
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
    // El documento sube en la misma proporción: 4.1234 × 1 500 / 1 426.230 = 4.3367.
    const strips = await prisma.coil.findMany({ where: { parentCoilId: motherId } });
    for (const s of strips) expect(s.unitCostPerKg.toFixed(4)).toBe('4.3367');
    // La madre conserva su promedio y le quedan sus 500 kg.
    const mother = await balance(motherId);
    expect(mother.qty.toFixed(3)).toBe('500.000');
    expect(mother.avgCost.toFixed(4)).toBe(UNIT_PRICE);
  });

  it('la reversa de la recepción lo deshace exacto (D-052)', async () => {
    const { orderId, motherId } = await sentCoil();
    const before = await balance(motherId);
    await receive(orderId, motherId);
    const { ins } = await receptionMovements(orderId, motherId);

    await cutting.reverse(
      admin,
      orderId,
      motherId,
      cancelCuttingOrderSchema.parse({ reason: 'Prueba de reversa del kerf cc44' }),
    );

    // La madre vuelve a sus kilos y su valorizado de antes de recibir.
    const mother = await balance(motherId);
    expect(mother.qty.toFixed(3)).toBe(before.qty.toFixed(3));
    expect(mother.avgCost.toFixed(4)).toBe(before.avgCost.toFixed(4));
    for (const m of ins) {
      const b = await balance(m.itemId);
      expect(b.qty.toFixed(3)).toBe('0.000');
      // Cada reversa saca exactamente el valor con el que el fleje entró, kerf incluido.
      const reversal = await prisma.inventoryMovement.findFirstOrThrow({
        where: { reversalOfId: m.id },
      });
      expect(reversal.totalCost.toFixed(4)).toBe(m.totalCost.toFixed(4));
    }
    const row = await prisma.cuttingOrderCoil.findFirstOrThrow({
      where: { cuttingOrderId: orderId, coilId: motherId },
    });
    expect(row.status).toBe('SENT');
    expect(row.receivedKerfLossKg).toBeNull();
    // Valor de los flejes vivo: cero. Todo volvió a la madre.
    for (const m of ins) {
      const b = await balance(m.itemId);
      expect(dec(b.qty).times(dec(b.avgCost)).toFixed(4)).toBe('0.0000');
    }

    // Recibir de nuevo reparte otra vez exacto, sin arrastrar nada de la generación revertida.
    await receive(orderId, motherId);
    const again = await receptionMovements(orderId, motherId);
    expect(again.ins.map((m) => m.id)).not.toEqual(ins.map((m) => m.id));
    expect(sum(again.ins.map((m) => dec(m.totalCost))).toFixed(4)).toBe(
      again.out.totalCost.toFixed(4),
    );
    expect(again.out.totalCost.toFixed(4)).toBe('6185.1000');
  });

  it('en una bobina en USD el kardex reparte en soles y el documento sube en dólares', async () => {
    const { orderId, motherId } = await sentCoil('USD');
    await receive(orderId, motherId);
    const { out, ins } = await receptionMovements(orderId, motherId);
    // La compra entra por S/ 30 925.50 (2 000 kg × 4.1234 USD × 3.75): promedio 15.4628 a 4
    // decimales, así que 1 500 kg salen por S/ 23 194.20.
    expect(out.totalCost.toFixed(4)).toBe('23194.2000');
    expect(sum(ins.map((m) => dec(m.totalCost))).toFixed(4)).toBe('23194.2000');
    const strips = await prisma.coil.findMany({ where: { parentCoilId: motherId } });
    for (const s of strips) {
      // El documento sigue en dólares, subido en la misma proporción que en soles.
      expect(s.currency).toBe('USD');
      expect(s.unitCostPerKg.toFixed(4)).toBe('4.3367');
      // El total en soles del fleje es su valor de kardex.
      const entry = ins.find((m) => m.itemId === s.id);
      expect(s.totalCostPen.toFixed(4)).toBe(entry?.totalCost.toFixed(4));
    }
  });

  it('la factura del corte que llega después suma por kilo encima del kerf (RF-41)', async () => {
    const { orderId, motherId } = await sentCoil();
    await receive(orderId, motherId);
    const { out, ins } = await receptionMovements(orderId, motherId);

    const service = await purchases.create(
      admin,
      createPurchaseSchema.parse({
        supplierId: cutterId,
        docType: 'FACTURA',
        series: 'F001',
        number: digits(8),
        issueDate: businessToday(),
        currency: 'PEN',
        paymentTerms: 'CONTADO',
        businessLine: 'drywall',
        type: 'SERVICE',
        serviceKind: 'CUTTING',
        relatedCuttingOrderId: orderId,
        items: [{ description: 'Corte cc44', qty: '1', unit: 'ZZ', unitPrice: '300' }],
      }),
    );
    await purchases.receive(admin, service.id);

    const adjusts = await prisma.inventoryMovement.findMany({
      where: { refType: 'PURCHASE', refId: service.id, type: 'ADJUST' },
    });
    expect(adjusts).toHaveLength(2);
    expect(sum(adjusts.map((a) => dec(a.totalCost))).toFixed(4)).toBe('300.0000');
    // Los flejes valen lo que salió de la madre más el servicio, al céntimo.
    const stripValue = sum([...ins, ...adjusts].map((m) => dec(m.totalCost)));
    expect(stripValue.toFixed(4)).toBe(dec(out.totalCost).plus(300).toFixed(4));
    for (const m of ins) {
      const b = await balance(m.itemId);
      expect(b.qty.toFixed(3)).toBe(m.qty.toFixed(3));
    }
  });
});
