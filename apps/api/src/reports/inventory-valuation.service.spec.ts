import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { Decimal, toDecimal } from '@ayr/shared';
import { InventoryValuationService } from './inventory-valuation.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * RF-S4a/M1. Dos cosas se prueban acá y no son la misma:
 *
 * 1. **Conciliación.** El total del reporte tiene que ser exactamente la suma de los saldos
 *    valorizados del kardex. Lo que puede romperla no es la suma —eso es trivial— sino
 *    redondear en el nivel equivocado: si cada grupo se redondea a 4 decimales y después se
 *    suman los grupos, el total se aparta de la suma de las filas. Los casos de acá eligen
 *    números donde esa diferencia aparece, porque con números redondos el bug no se ve.
 * 2. **Presupuesto de consultas (D-228).** Dos consultas, fijas, y lo que importa no es el
 *    número sino que **no dependa de N**: el mismo conteo con una bobina y con doce.
 */

interface QueryCall {
  sql: string;
}

function decimal(v: string): Prisma.Decimal {
  return new Prisma.Decimal(v);
}

interface CoilSeed {
  id: string;
  code: string;
  line: string;
  thickness: string;
  color: string | null;
  qty: string;
  avgCost: string;
}

interface ProductSeed {
  id: string;
  line: string;
  sku: string;
  qty: string;
  avgCost: string;
}

function coilRow(seed: CoilSeed): Record<string, unknown> {
  return {
    item_id: seed.id,
    qty: decimal(seed.qty),
    avg_cost: decimal(seed.avgCost),
    business_line_code: seed.line,
    code: seed.code,
    type_key: `PINT-${seed.thickness}`,
    kind: 'COIL',
    width_mm: decimal('1200'),
    thickness_mm: decimal(seed.thickness),
    color_name: seed.color,
    status: 'OPEN',
    operation_date: new Date('2026-09-01T00:00:00.000Z'),
  };
}

function productRow(seed: ProductSeed): Record<string, unknown> {
  return {
    item_id: seed.id,
    qty: decimal(seed.qty),
    avg_cost: decimal(seed.avgCost),
    unit: 'NIU',
    business_line_code: seed.line,
    sku: seed.sku,
    name: `Producto ${seed.sku}`,
  };
}

async function buildService(options: {
  coils?: CoilSeed[];
  products?: ProductSeed[];
}): Promise<{ service: InventoryValuationService; calls: QueryCall[] }> {
  const calls: QueryCall[] = [];
  const queryRaw = jest.fn((strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    calls.push({ sql });
    if (sql.includes('"coils"')) {
      return Promise.resolve((options.coils ?? []).map(coilRow));
    }
    return Promise.resolve((options.products ?? []).map(productRow));
  });

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      InventoryValuationService,
      { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
    ],
  }).compile();

  return { service: module.get(InventoryValuationService), calls };
}

/** La suma de referencia, calculada aparte del servicio para que no se prueben entre sí. */
function expectedTotal(coils: CoilSeed[], products: ProductSeed[]): Decimal {
  const add = (acc: Decimal, qty: string, cost: string): Decimal =>
    acc.plus(toDecimal(qty).times(toDecimal(cost)));
  const coilTotal = coils.reduce((acc, c) => add(acc, c.qty, c.avgCost), new Decimal(0));
  return products.reduce((acc, p) => add(acc, p.qty, p.avgCost), coilTotal);
}

describe('InventoryValuationService', () => {
  it('concilia con el kardex: el total es la suma de los saldos valorizados', async () => {
    const coils: CoilSeed[] = [
      {
        id: 'c1',
        code: 'BOB-1',
        line: 'drywall',
        thickness: '0.50',
        color: null,
        qty: '1200.500',
        avgCost: '4.2345',
      },
      {
        id: 'c2',
        code: 'BOB-2',
        line: 'drywall',
        thickness: '0.50',
        color: null,
        qty: '340.250',
        avgCost: '4.9911',
      },
      {
        id: 'c3',
        code: 'BOB-3',
        line: 'metallic-roofing',
        thickness: '0.45',
        color: 'Rojo Teja',
        qty: '77.333',
        avgCost: '5.1234',
      },
    ];
    const products: ProductSeed[] = [
      { id: 'p1', line: 'drywall', sku: 'SKU-1', qty: '13.000', avgCost: '18.7766' },
    ];

    const { service } = await buildService({ coils, products });
    const report = await service.valuation();

    expect(report.totals.totalValuePen).toBe(expectedTotal(coils, products).toFixed(4));
  });

  it('el total no se aparta de la suma de las filas cuando el redondeo por grupo lo movería', async () => {
    // Tres bobinas cuyo valor individual cae **debajo** de la escala dinero: 0.00005 cada
    // una. Redondeando fila por fila y sumando después da 0.0003; el valor real del grupo es
    // 0.00015, que redondea a 0.0002. El reporte tiene que decir 0.0002.
    const coils: CoilSeed[] = [
      {
        id: 'c1',
        code: 'BOB-1',
        line: 'drywall',
        thickness: '0.50',
        color: null,
        qty: '1.000',
        avgCost: '0.00005',
      },
      {
        id: 'c2',
        code: 'BOB-2',
        line: 'drywall',
        thickness: '0.50',
        color: null,
        qty: '1.000',
        avgCost: '0.00005',
      },
      {
        id: 'c3',
        code: 'BOB-3',
        line: 'drywall',
        thickness: '0.50',
        color: null,
        qty: '1.000',
        avgCost: '0.00005',
      },
    ];

    const { service } = await buildService({ coils });
    const report = await service.valuation();

    expect(report.coilGroups).toHaveLength(1);
    expect(report.coilGroups[0]!.totalValuePen).toBe('0.0002');
    expect(report.totals.totalValuePen).toBe('0.0002');
    // Y la suma de las filas redondeadas es la otra cosa, la que NO se reporta.
    const sumOfRows = report.coilGroups[0]!.coils.reduce(
      (acc, c) => acc.plus(toDecimal(c.totalValuePen)),
      new Decimal(0),
    );
    expect(sumOfRows.toFixed(4)).toBe('0.0003');
  });

  it('agrupa por línea, espesor y color, con el color nulo como grupo propio', async () => {
    const coils: CoilSeed[] = [
      {
        id: 'c1',
        code: 'BOB-1',
        line: 'metallic-roofing',
        thickness: '0.45',
        color: 'Rojo Teja',
        qty: '100.000',
        avgCost: '5.0000',
      },
      {
        id: 'c2',
        code: 'BOB-2',
        line: 'metallic-roofing',
        thickness: '0.45',
        color: 'Rojo Teja',
        qty: '50.000',
        avgCost: '6.0000',
      },
      {
        id: 'c3',
        code: 'BOB-3',
        line: 'metallic-roofing',
        thickness: '0.45',
        color: null,
        qty: '10.000',
        avgCost: '4.0000',
      },
      {
        id: 'c4',
        code: 'BOB-4',
        line: 'metallic-roofing',
        thickness: '0.50',
        color: 'Rojo Teja',
        qty: '10.000',
        avgCost: '4.0000',
      },
      {
        id: 'c5',
        code: 'BOB-5',
        line: 'drywall',
        thickness: '0.45',
        color: 'Rojo Teja',
        qty: '10.000',
        avgCost: '4.0000',
      },
    ];

    const { service } = await buildService({ coils });
    const report = await service.valuation();

    // Cuatro grupos: cambiar cualquiera de los tres ejes abre uno nuevo.
    expect(report.coilGroups).toHaveLength(4);
    const first = report.coilGroups[0]!;
    expect(first.coilCount).toBe(2);
    expect(first.qtyKg).toBe('150.000');
    // Valor total / cantidad total = 800 / 150 = 5.3333…, y **no** el promedio de los dos
    // promedios (5.5000), que es el error que este caso está puesto a detectar.
    expect(first.totalValuePen).toBe('800.0000');
    expect(first.avgCostPen).toBe('5.3333');
  });

  it('los totales por línea suman el total general', async () => {
    const coils: CoilSeed[] = [
      {
        id: 'c1',
        code: 'BOB-1',
        line: 'drywall',
        thickness: '0.50',
        color: null,
        qty: '100.000',
        avgCost: '4.0000',
      },
      {
        id: 'c2',
        code: 'BOB-2',
        line: 'metallic-roofing',
        thickness: '0.45',
        color: 'Azul',
        qty: '200.000',
        avgCost: '5.0000',
      },
    ];
    const products: ProductSeed[] = [
      { id: 'p1', line: 'drywall', sku: 'SKU-1', qty: '10.000', avgCost: '2.0000' },
    ];

    const { service } = await buildService({ coils, products });
    const report = await service.valuation();

    expect(report.totalsByLine).toEqual([
      {
        businessLine: 'drywall',
        coilValuePen: '400.0000',
        productValuePen: '20.0000',
        totalValuePen: '420.0000',
      },
      {
        businessLine: 'metallic-roofing',
        coilValuePen: '1000.0000',
        productValuePen: '0.0000',
        totalValuePen: '1000.0000',
      },
    ]);
    expect(report.totals).toEqual({
      coilValuePen: '1400.0000',
      productValuePen: '20.0000',
      totalValuePen: '1420.0000',
    });
  });

  it('presupuesto de consultas: dos, y el conteo no cambia con doce bobinas en cuatro grupos', async () => {
    const one = await buildService({
      coils: [
        {
          id: 'c1',
          code: 'BOB-1',
          line: 'drywall',
          thickness: '0.50',
          color: null,
          qty: '1.000',
          avgCost: '1.0000',
        },
      ],
      products: [{ id: 'p1', line: 'drywall', sku: 'SKU-1', qty: '1.000', avgCost: '1.0000' }],
    });
    await one.service.valuation();
    expect(one.calls).toHaveLength(2);

    const many = await buildService({
      coils: Array.from({ length: 12 }, (_, i) => ({
        id: `c${i}`,
        code: `BOB-${i}`,
        line: i % 2 === 0 ? 'drywall' : 'metallic-roofing',
        thickness: i % 4 < 2 ? '0.50' : '0.45',
        color: null,
        qty: '1.000',
        avgCost: '1.0000',
      })),
      products: Array.from({ length: 12 }, (_, i) => ({
        id: `p${i}`,
        line: 'drywall',
        sku: `SKU-${i}`,
        qty: '1.000',
        avgCost: '1.0000',
      })),
    });
    const report = await many.service.valuation();

    expect(many.calls).toHaveLength(2);
    expect(report.coilGroups).toHaveLength(4);
    expect(report.products).toHaveLength(12);
  });

  it('un rango sin saldos devuelve totales en cero, no filas vacías', async () => {
    const { service } = await buildService({});
    const report = await service.valuation();

    expect(report.coilGroups).toEqual([]);
    expect(report.products).toEqual([]);
    expect(report.totalsByLine).toEqual([]);
    expect(report.totals.totalValuePen).toBe('0.0000');
  });
});
