import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { Role } from '@prisma/client';
import {
  businessToday,
  COIL_REPORT_LINES,
  dashboardMonthRanges,
  plantWeekRange,
} from '@ayr/shared';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AppModule } from '../app.module';
import type { RequestUser } from '../auth/auth.types';
import { CoilsService } from '../coils/coils.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionService } from '../production/production.service';
import { RoofingProductionService } from '../production/roofing-production.service';
import { AdminDashboardService } from './admin-dashboard.service';
import { CoilWasteService } from './coil-waste.service';
import { InventoryValuationService } from './inventory-valuation.service';
import { PlantDashboardService } from './plant-dashboard.service';
import { ReceivablesAgingService } from './receivables-aging.service';
import { SalesMarginService } from './sales-margin.service';

/**
 * cc26 (D-440; segundo modelo, P2 R2) — **el presupuesto de consultas de los dos Paneles, medido
 * en SQL contra una base real.** Cada sentencia que Prisma manda a Postgres se cuenta con su
 * evento `query`.
 *
 * Lo que se fija: el Panel cuesta **exactamente** lo mismo que leer sus reportes uno por uno para
 * los mismos rangos —ni una consulta propia, ni un reporte leído dos veces— y queda bajo un techo
 * fijo. Que cada reporte no crezca con las filas ya lo fijan sus propios specs de presupuesto
 * (D-228: ventas y margen, CxC, inventario valorizado, merma).
 *
 * Corre en `pnpm --filter @ayr/api test:db` (base de pruebas recién reseteada y sembrada).
 */
// `pg-boss` es ESM y Jest no lo transforma; con `JOBS_ENABLED=false` las colas nunca arrancan.
jest.mock('pg-boss', () => ({ PgBoss: class {} }));
process.env.JOBS_ENABLED = 'false';
jest.setTimeout(5 * 60_000);

/** Techo del Panel del administrador: la suma de sus reportes hoy, con holgura para crecer. */
const ADMIN_CEILING = 60;
/**
 * Techos del de planta: lo fijo (cola, órdenes vivas y cuatro lecturas de merma) y cada página
 * de 200 bobinas abiertas, que el Panel recorre hasta su total (en la CI, los otros `db-spec`
 * dejan más de 200).
 */
const PLANT_FIXED_CEILING = 45;
const PLANT_PAGE_CEILING = 12;

/**
 * cc34 — además de contar, se guarda **qué** sentencia salió. `dashboards.db-spec` falló seis veces
 * en la CI con el Panel una consulta por debajo de sus reportes (24/25, 15/16) y nunca en local,
 * ni con los datos de la CI (25 consultas, 15 repeticiones) ni con 16 Paneles en paralelo; los
 * eventos tampoco llegaban tarde. Comparar el multiconjunto de sentencias es más estricto que el
 * conteo y, si vuelve a fallar, el mensaje dice cuál sobra o falta.
 */
class CountingPrisma extends PrismaService {
  readonly statements: string[] = [];
  constructor() {
    super({ log: [{ emit: 'event', level: 'query' }] });
    (this as unknown as { $on: (e: 'query', cb: (e: { query: string }) => void) => void }).$on(
      'query',
      (e) => {
        this.statements.push(e.query.replace(/\s+/g, ' ').trim());
      },
    );
  }
}

let moduleRef: TestingModule;
let prisma: CountingPrisma;

/** Las sentencias que mandó `run`. */
async function measure(run: () => Promise<unknown>): Promise<string[]> {
  const before = prisma.statements.length;
  await run();
  return prisma.statements.slice(before);
}

/** Lo que difiere entre dos multiconjuntos de sentencias: «n en a → m en b: sentencia». */
function statementDiff(a: readonly string[], b: readonly string[]): string[] {
  const tally = (xs: readonly string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ta = tally(a);
  const tb = tally(b);
  return [...new Set([...ta.keys(), ...tb.keys()])]
    .filter((k) => (ta.get(k) ?? 0) !== (tb.get(k) ?? 0))
    .map((k) => `${String(ta.get(k) ?? 0)} → ${String(tb.get(k) ?? 0)}: ${k.slice(0, 300)}`);
}

beforeAll(async () => {
  assertTestDatabase();
  prisma = new CountingPrisma();
  moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  await moduleRef.init();
});

afterAll(async () => {
  await moduleRef?.close();
});

it('el Panel del administrador cuesta lo mismo que sus reportes, sin consultas propias', async () => {
  const today = businessToday();
  const { current, previous } = dashboardMonthRanges(today);
  const sales = moduleRef.get(SalesMarginService);
  const aging = moduleRef.get(ReceivablesAgingService);
  const valuation = moduleRef.get(InventoryValuationService);
  const waste = moduleRef.get(CoilWasteService);

  // Uno por uno: medidas en paralelo se contarían las consultas de las otras.
  const reports = [
    ...(await measure(() => sales.salesMargin(current))),
    ...(await measure(() => sales.salesMargin(previous))),
    ...(await measure(() => aging.report({}))),
    ...(await measure(() => valuation.valuation({}))),
  ];
  for (const businessLine of COIL_REPORT_LINES) {
    reports.push(...(await measure(() => waste.report({ ...current, businessLine }))));
  }

  const panel = await measure(() => moduleRef.get(AdminDashboardService).dashboard(today));
  // Las mismas sentencias, las mismas veces (reportes → Panel).
  expect(statementDiff(reports, panel)).toEqual([]);
  expect(panel.length).toBe(reports.length);
  expect(panel.length).toBeLessThanOrEqual(ADMIN_CEILING);
});

it('el Panel de planta cuesta lo mismo que sus lecturas, sin consultas propias', async () => {
  const today = businessToday();
  const week = plantWeekRange(today);
  const user = await prisma.user.findFirstOrThrow({ where: { role: Role.ADMINISTRADOR } });
  const actor: RequestUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: Role.SUPERVISOR_PLANTA,
    mustChangePassword: false,
    sessionId: randomUUID(),
  };
  const waste = moduleRef.get(CoilWasteService);

  const reads = [
    ...(await measure(() => moduleRef.get(RoofingProductionService).queue(actor))),
    ...(await measure(() =>
      moduleRef.get(ProductionService).findAll({ status: ['DRAFT', 'IN_PROGRESS'] }),
    )),
  ];
  for (const range of [{ from: today, to: today }, week]) {
    for (const businessLine of COIL_REPORT_LINES) {
      reads.push(...(await measure(() => waste.report({ ...range, businessLine }))));
    }
  }

  // Las bobinas, por las mismas páginas que recorre el Panel.
  const coils = moduleRef.get(CoilsService);
  const coilReads: string[] = [];
  let pages = 0;
  for (let page = 1, seen = 0; ; page += 1) {
    let res: Awaited<ReturnType<CoilsService['findAll']>> | undefined;
    const pageReads = await measure(async () => {
      res = await coils.findAll({
        status: ['OPEN'],
        kind: 'COIL',
        availability: 'available',
        page,
        pageSize: 200,
      });
    });
    coilReads.push(...pageReads);
    pages += 1;
    seen += res?.items.length ?? 0;
    if (seen >= (res?.total ?? 0) || (res?.items.length ?? 0) === 0) break;
  }

  const panel = await measure(() => moduleRef.get(PlantDashboardService).dashboard(actor, today));
  expect(statementDiff([...reads, ...coilReads], panel)).toEqual([]);
  expect(panel.length).toBe(reads.length + coilReads.length);
  expect(reads.length).toBeLessThanOrEqual(PLANT_FIXED_CEILING);
  expect(coilReads.length).toBeLessThanOrEqual(PLANT_PAGE_CEILING * pages);
});
