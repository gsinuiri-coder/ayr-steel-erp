import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { ReportsService, coilInMonth } from './reports.service';

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
    // D-340: el reporte incluye la bobina según su primer movimiento de kardex.
    first_movement_date: new Date('2026-08-05T00:00:00Z'),
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

/**
 * D-340 — una bobina entra al reporte del mes de su **primer movimiento de kardex**, no del mes de su
 * fecha de alta. El caso real: la carga de V-4 tiene fecha de alta en septiembre, pero D-285 fechó sus
 * movimientos el 2026-08-01. Con la fecha de alta, agosto no las contaba y septiembre las traía con
 * saldo inicial: el saldo final de agosto no coincidía con el inicial de septiembre (46 805 kg).
 *
 * `$queryRaw` se simula con un evaluador en memoria de lo que la consulta agrega (saldo a dos fechas y
 * primer movimiento por bobina, **sin** filtrar por mes: ese filtro es de `coilInMonth`), para probar
 * el invariante contra el código real del servicio.
 */
describe('ReportsService.coilsByMonth (D-340)', () => {
  interface Move {
    date: string;
    type: 'IN' | 'OUT';
    qty: number;
    cost: number;
  }
  interface Fixture {
    id: string;
    code: string;
    /** Fecha de alta de la bobina (`coils.operation_date`). */
    alta: string;
    status?: string;
    moves: Move[];
  }

  const day = (s: string) => new Date(`${s}T00:00:00Z`);

  function evaluate(fixtures: Fixture[]) {
    return (_strings: TemplateStringsArray, ...values: unknown[]) => {
      // Los dos primeros parámetros de la consulta son el inicio del mes y el del siguiente.
      const from = values[0] as Date;
      const nextFrom = values[1] as Date;
      return Promise.resolve(
        fixtures.map((f) => {
          const sum = (limit: Date, pick: (m: Move) => number) =>
            f.moves
              .filter((m) => day(m.date) < limit)
              .reduce((acc, m) => acc + (m.type === 'IN' ? pick(m) : -pick(m)), 0);
          const first = f.moves.map((m) => m.date).sort((a, b) => a.localeCompare(b))[0];
          return {
            id: f.id,
            code: f.code,
            type_key: 'GALV-0.50',
            kind: 'COIL',
            business_line_code: 'drywall',
            color_name: null,
            width_mm: new Prisma.Decimal('1220'),
            weight_kg: new Prisma.Decimal(sum(day('2100-01-01'), (m) => m.qty)),
            unit_cost_per_kg: new Prisma.Decimal('4'),
            status: f.status ?? 'OPEN',
            operation_date: day(f.alta),
            opening_kg: new Prisma.Decimal(sum(from, (m) => m.qty)),
            closing_kg: new Prisma.Decimal(sum(nextFrom, (m) => m.qty)),
            closing_value: new Prisma.Decimal(sum(nextFrom, (m) => m.cost)),
            last_film_event: null,
            first_movement_date: first === undefined ? null : day(first),
          };
        }),
      );
    };
  }

  const fixtures: Fixture[] = [
    // Comprada en agosto: alta y movimiento en agosto.
    {
      id: 'a',
      code: 'B-A',
      alta: '2026-08-10',
      moves: [{ date: '2026-08-10', type: 'IN', qty: 1000, cost: 4000 }],
    },
    // Carga inicial de V-4: **alta en septiembre, primer movimiento el 1 de agosto** (D-285).
    {
      id: 'b',
      code: 'SALDO-B',
      alta: '2026-09-15',
      moves: [{ date: '2026-08-01', type: 'IN', qty: 3100, cost: 12400 }],
    },
    // Comprada en septiembre de verdad: no existe en agosto.
    {
      id: 'c',
      code: 'B-C',
      alta: '2026-09-20',
      moves: [{ date: '2026-09-20', type: 'IN', qty: 500, cost: 2000 }],
    },
    // Anulada en septiembre (entrada y reversa): en agosto tenía sus kilos y desde septiembre 0;
    // se trataba igual antes de esta corrección.
    {
      id: 'd',
      code: 'B-D',
      alta: '2026-08-12',
      status: 'CANCELLED',
      moves: [
        { date: '2026-08-12', type: 'IN', qty: 200, cost: 800 },
        { date: '2026-09-03', type: 'OUT', qty: 200, cost: 800 },
      ],
    },
  ];

  function service(): ReportsService {
    const prisma = { $queryRaw: jest.fn(evaluate(fixtures)) } as unknown as PrismaService;
    return new ReportsService(prisma);
  }

  type Report = Awaited<ReturnType<ReportsService['coilsByMonth']>>;
  const codes = (r: Report) => [...r.sealed.rows, ...r.opened.rows].map((x) => x.code).sort();
  const byCode = (r: Report, code: string) =>
    [...r.sealed.rows, ...r.opened.rows].find((x) => x.code === code)!;

  it('agosto incluye la bobina de la carga de V-4 aunque su alta sea de septiembre', async () => {
    const aug = await service().coilsByMonth({ month: '2026-08' }, true);
    expect(codes(aug)).toEqual(['B-A', 'B-D', 'SALDO-B']);
    expect(aug.totals.closingKg).toBe('4300.000'); // 1000 + 3100 + 200
  });

  it('septiembre las trae a todas', async () => {
    const sep = await service().coilsByMonth({ month: '2026-09' }, true);
    expect(codes(sep)).toEqual(['B-A', 'B-C', 'B-D', 'SALDO-B']);
  });

  it('el saldo final de cada mes coincide con el inicial del siguiente (el invariante)', async () => {
    const svc = service();
    const months = ['2026-07', '2026-08', '2026-09', '2026-10'];
    const reports = await Promise.all(months.map((m) => svc.coilsByMonth({ month: m }, true)));
    for (let i = 0; i < reports.length - 1; i += 1) {
      expect(reports[i]!.totals.closingKg).toBe(reports[i + 1]!.totals.openingKg);
    }
    // Agosto cierra en 4 300 kg: es exactamente lo que septiembre trae como saldo inicial.
    expect(reports[1]!.totals.closingKg).toBe('4300.000');
    expect(reports[2]!.totals.openingKg).toBe('4300.000');
  });

  it('un mes anterior a todos los movimientos queda vacío', async () => {
    const jul = await service().coilsByMonth({ month: '2026-07' }, true);
    expect(codes(jul)).toEqual([]);
    expect(jul.totals.closingKg).toBe('0.000');
  });

  it('la anulada figura con sus kilos de entonces en agosto y en 0 desde septiembre', async () => {
    const svc = service();
    const aug = await svc.coilsByMonth({ month: '2026-08' }, true);
    const sep = await svc.coilsByMonth({ month: '2026-09' }, true);
    expect(byCode(aug, 'B-D').closingKg).toBe('200.000');
    expect(byCode(sep, 'B-D').closingKg).toBe('0.000');
  });
});

describe('coilInMonth (D-340)', () => {
  const nextMonth = new Date('2026-09-01T00:00:00Z');

  it('incluye la bobina con un primer movimiento anterior al primer día del mes siguiente', () => {
    expect(coilInMonth(new Date('2026-08-01T00:00:00Z'), nextMonth)).toBe(true);
    expect(coilInMonth(new Date('2026-08-31T00:00:00Z'), nextMonth)).toBe(true);
  });

  it('excluye la que empieza el primer día del mes siguiente o después, y la que no tiene movimientos', () => {
    expect(coilInMonth(new Date('2026-09-01T00:00:00Z'), nextMonth)).toBe(false);
    expect(coilInMonth(new Date('2026-10-05T00:00:00Z'), nextMonth)).toBe(false);
    expect(coilInMonth(null, nextMonth)).toBe(false);
  });
});
