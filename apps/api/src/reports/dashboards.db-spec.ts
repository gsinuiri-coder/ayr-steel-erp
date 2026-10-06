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

class CountingPrisma extends PrismaService {
  count = 0;
  constructor() {
    super({ log: [{ emit: 'event', level: 'query' }] });
    (this as unknown as { $on: (e: 'query', cb: () => void) => void }).$on('query', () => {
      this.count += 1;
    });
  }
}

let moduleRef: TestingModule;
let prisma: CountingPrisma;

async function measure(run: () => Promise<unknown>): Promise<number> {
  const before = prisma.count;
  await run();
  return prisma.count - before;
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
  let reports =
    (await measure(() => sales.salesMargin(current))) +
    (await measure(() => sales.salesMargin(previous))) +
    (await measure(() => aging.report({}))) +
    (await measure(() => valuation.valuation({})));
  for (const businessLine of COIL_REPORT_LINES) {
    reports += await measure(() => waste.report({ ...current, businessLine }));
  }

  const panel = await measure(() => moduleRef.get(AdminDashboardService).dashboard(today));
  expect(panel).toBe(reports);
  expect(panel).toBeLessThanOrEqual(ADMIN_CEILING);
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

  let reads =
    (await measure(() => moduleRef.get(RoofingProductionService).queue(actor))) +
    (await measure(() =>
      moduleRef.get(ProductionService).findAll({ status: ['DRAFT', 'IN_PROGRESS'] }),
    )) +
    0;
  for (const range of [{ from: today, to: today }, week]) {
    for (const businessLine of COIL_REPORT_LINES) {
      reads += await measure(() => waste.report({ ...range, businessLine }));
    }
  }

  // Las bobinas, por las mismas páginas que recorre el Panel.
  const coils = moduleRef.get(CoilsService);
  let coilReads = 0;
  let pages = 0;
  for (let page = 1, seen = 0; ; page += 1) {
    let res: Awaited<ReturnType<CoilsService['findAll']>> | undefined;
    coilReads += await measure(async () => {
      res = await coils.findAll({
        status: ['OPEN'],
        kind: 'COIL',
        availability: 'available',
        page,
        pageSize: 200,
      });
    });
    pages += 1;
    seen += res?.items.length ?? 0;
    if (seen >= (res?.total ?? 0) || (res?.items.length ?? 0) === 0) break;
  }

  const panel = await measure(() => moduleRef.get(PlantDashboardService).dashboard(actor, today));
  expect(panel).toBe(reads + coilReads);
  expect(reads).toBeLessThanOrEqual(PLANT_FIXED_CEILING);
  expect(coilReads).toBeLessThanOrEqual(PLANT_PAGE_CEILING * pages);
});
