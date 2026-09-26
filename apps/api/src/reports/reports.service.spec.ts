import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from './reports.service';

/**
 * D-328 — el reporte mensual de bobinas en dos tablas. La consulta SQL (el estado del film **al
 * último día del mes**, por el último evento con `operation_date` hasta esa fecha) se prueba
 * contra una base real en E2E; acá se prueba lo que hace el servicio con lo que ella devuelve:
 * repartir cada bobina en «Selladas» o «Abiertas», sumar cada tabla y el total general, y no
 * mostrar valores a quien no ve costos.
 */

interface RawRow {
  id: string;
  code: string;
  status: string;
  opening: string;
  closing: string;
  weight?: string;
  value?: string;
  event: string | null;
}

function raw(r: RawRow) {
  return {
    id: r.id,
    code: r.code,
    type_key: 'GALV-0.50',
    kind: 'COIL',
    business_line_code: 'drywall',
    color_name: null,
    width_mm: new Prisma.Decimal('1220'),
    weight_kg: new Prisma.Decimal(r.weight ?? '1000'),
    unit_cost_per_kg: new Prisma.Decimal('4.2'),
    status: r.status,
    operation_date: new Date('2026-08-05T00:00:00Z'),
    opening_kg: new Prisma.Decimal(r.opening),
    closing_kg: new Prisma.Decimal(r.closing),
    closing_value: new Prisma.Decimal(r.value ?? '0'),
    last_film_event: r.event,
  };
}

function serviceWith(rows: ReturnType<typeof raw>[]): ReportsService {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue(rows) } as unknown as PrismaService;
  return new ReportsService(prisma);
}

describe('ReportsService.coilsByMonth (D-328)', () => {
  const rows = [
    // Sellada al 31 de agosto: nunca se abrió.
    raw({
      id: 'a',
      code: 'B-A',
      status: 'OPEN',
      opening: '1000',
      closing: '1000',
      value: '4200',
      event: null,
    }),
    // Abierta al 31 de agosto: se abrió y se usó.
    raw({
      id: 'b',
      code: 'B-B',
      status: 'OPEN',
      opening: '1000',
      closing: '600',
      value: '2520',
      event: 'OPENED',
    }),
    // Se abrió y se volvió a sellar antes del corte: cuenta como sellada.
    raw({
      id: 'c',
      code: 'B-C',
      status: 'OPEN',
      opening: '500',
      closing: '500',
      value: '2100',
      event: 'RESEALED',
    }),
    // Terminada con saldo final 0: va a «Abiertas» sin haber tenido nunca un evento.
    raw({
      id: 'd',
      code: 'B-D',
      status: 'CLOSED',
      opening: '200',
      closing: '0',
      value: '0',
      event: null,
    }),
    // Terminada hoy, pero al 31 de agosto todavía tenía saldo y seguía sellada.
    raw({
      id: 'e',
      code: 'B-E',
      status: 'CLOSED',
      opening: '300',
      closing: '300',
      value: '1260',
      event: null,
    }),
  ];

  it('reparte cada bobina según su film al fin de mes', async () => {
    const report = await serviceWith(rows).coilsByMonth({ month: '2026-08' }, true);
    expect(report.sealed.rows.map((r) => r.code)).toEqual(['B-A', 'B-C', 'B-E']);
    expect(report.opened.rows.map((r) => r.code)).toEqual(['B-B', 'B-D']);
  });

  it('cada tabla lleva sus subtotales y el total general es su suma exacta', async () => {
    const report = await serviceWith(rows).coilsByMonth({ month: '2026-08' }, true);
    expect(report.sealed.totals).toEqual({
      openingKg: '1800.000',
      weightKg: '3000.000',
      closingKg: '1800.000',
      closingValuePen: '7560.0000',
    });
    expect(report.opened.totals).toEqual({
      openingKg: '1200.000',
      weightKg: '2000.000',
      closingKg: '600.000',
      closingValuePen: '2520.0000',
    });
    expect(report.totals).toEqual({
      openingKg: '3000.000',
      weightKg: '5000.000',
      closingKg: '2400.000',
      closingValuePen: '10080.0000',
    });
  });

  it('el total general cuadra con la suma de todas las filas, estén en la tabla que estén', async () => {
    const report = await serviceWith(rows).coilsByMonth({ month: '2026-08' }, true);
    const all = [...report.sealed.rows, ...report.opened.rows];
    expect(all).toHaveLength(rows.length);
    const sumClosing = all.reduce((acc, r) => acc + Number(r.closingKg), 0);
    expect(sumClosing).toBe(Number(report.totals.closingKg));
  });

  it('sin permiso de costos no viaja ni el costo por kg ni ningún valor', async () => {
    const report = await serviceWith(rows).coilsByMonth({ month: '2026-08' }, false);
    expect(report.sealed.rows.every((r) => r.unitCostPerKg === null)).toBe(true);
    expect(report.sealed.rows.every((r) => r.closingValuePen === null)).toBe(true);
    expect(report.sealed.totals.closingValuePen).toBeNull();
    expect(report.opened.totals.closingValuePen).toBeNull();
    expect(report.totals.closingValuePen).toBeNull();
    // Los kilos sí.
    expect(report.totals.closingKg).toBe('2400.000');
  });

  it('un mes sin bobinas devuelve dos tablas vacías con totales en cero', async () => {
    const report = await serviceWith([]).coilsByMonth({ month: '2026-08' }, true);
    expect(report.sealed.rows).toEqual([]);
    expect(report.opened.rows).toEqual([]);
    expect(report.totals.closingKg).toBe('0.000');
    expect(report.totals.closingValuePen).toBe('0.0000');
    expect(report.from).toBe('2026-08-01');
    expect(report.to).toBe('2026-08-31');
  });

  it('cada fila conserva su forma: línea, ancho con escala y fecha de alta', async () => {
    const report = await serviceWith([rows[0]!]).coilsByMonth({ month: '2026-08' }, true);
    expect(report.sealed.rows[0]).toMatchObject({
      id: 'a',
      widthMm: '1220.00',
      businessLine: 'drywall',
      operationDate: '2026-08-05',
      unitCostPerKg: '4.2000',
      closingValuePen: '4200.0000',
    });
  });
});
