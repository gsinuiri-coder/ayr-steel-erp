import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { minAllowedValue } from '@ayr/shared';
import { adminApi, getJson, postJson } from '../helpers/api';
import {
  balanceOf,
  createCatalogProduct,
  LINE,
  movementsOf,
  postExpectingError,
  today,
} from '../helpers/production';
import {
  createCustomer,
  createQuotationWithLines,
  purgeSalesTrail,
  stockPanel,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * dw-03 (D-712) — la carga inicial de perfiles de Drywall. Un perfil fabricado por unidades, con
 * su ficha completa, entra por `--kind products` como producto terminado (`IMPORT`, costo por pieza
 * cargado) y se vende por pedido contra ese stock, como uno producido a stock (D-598).
 *
 * Igual que `inventario-inicial-productos-f8s6a2.spec.ts`: no hay ruta HTTP (D-206 condición 2),
 * así que corre el CLI real contra la base de la suite y verifica por las rutas de lectura.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea stock y pedidos de verdad contra la base de pruebas: nunca contra producción (D-126).',
);
test.describe.configure({ timeout: 240_000 });

const REPO_ROOT = resolve(__dirname, '../..');

function runCli(filePath: string, extraArgs: string[] = []): { status: number; stdout: string } {
  const res = spawnSync(
    'node',
    [
      'scripts/import-initial-inventory.mjs',
      '--file',
      filePath,
      '--branch',
      'local-e2e',
      '--kind',
      'products',
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return { status: res.status ?? 1, stdout: `${res.stdout}\n${res.stderr}` };
}

function writeCsv(rows: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'inventario-inicial-perfiles-'));
  const path = join(dir, 'inventario-perfiles.csv');
  writeFileSync(
    path,
    [
      'SKU PRODUCTO,UNIDADES,COSTO UNITARIO (SIN IGV),MONEDA,TIPO DE CAMBIO,FACTURA DE REFERENCIA,FECHA DE REFERENCIA',
      ...rows,
    ].join('\n'),
    'utf8',
  );
  return path;
}

/** Un ancho de fleje que ningún otro test usa: este perfil no debe encontrar flejes ajenos. */
function uniqueWidth(): string {
  return (100 + Math.floor(Math.random() * 9000) / 100).toFixed(2);
}

test.describe('dw-03 — carga inicial de perfiles de Drywall (D-712)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  const floorOf = (productId: string) =>
    getJson<{
      minPricePen: string | null;
      priceUnitLabel: string | null;
      noFloorReason: string | null;
    }>(api, `/api/catalog/${productId}/price-floor`);

  async function minMarginPct(lineCode: string): Promise<string> {
    const settings = await getJson<{ businessLineCode: string; minMarginPct: string }[]>(
      api,
      '/api/pricing',
    );
    const setting = settings.find((s) => s.businessLineCode === lineCode);
    expect(setting, `La línea ${lineCode} no tiene márgenes configurados`).toBeDefined();
    return setting!.minMarginPct;
  }

  test('un perfil cargado como saldo inicial se vende por pedido contra ese stock (D-598)', async () => {
    const profile = await createCatalogProduct(api, {
      lineCode: LINE,
      unit: 'NIU',
      source: 'MANUFACTURED',
      thicknessMm: '0.43',
      widthMm: uniqueWidth(),
      lengthMm: '3000',
      pieceWeightKg: '1.32',
    });
    const customer = await createCustomer(api);
    const trail: { orderIds: string[]; quotationIds: string[] } = {
      orderIds: [],
      quotationIds: [],
    };
    const csvPath = writeCsv([`${profile.sku},100,3.1100,PEN,,,2026-08-01`]);

    try {
      // D-713: sin saldo y sin flejes de su ancho, el perfil no tiene piso (como hasta hoy).
      await expect(floorOf(profile.id)).resolves.toEqual({
        minPricePen: null,
        priceUnitLabel: null,
        noFloorReason: 'NO_COMPATIBLE_STRIPS',
      });

      const dry = runCli(csvPath);
      expect(dry.status, dry.stdout).toBe(0);
      expect(dry.stdout).toContain('Dry-run limpio');

      const exec = runCli(csvPath, ['--execute']);
      expect(exec.status, exec.stdout).toBe(0);
      expect(exec.stdout).toContain('1 línea(s) de producto creada(s)');

      const balance = await balanceOf(api, 'PRODUCT', profile.id);
      expect(balance.qty).toBe('100.000');
      expect(balance.avgCost).toBe('3.1100');
      const opening = (await movementsOf(api, 'PRODUCT', profile.id)).find((m) => m.type === 'IN');
      expect(opening?.refType).toBe('IMPORT');
      expect(opening?.notes).toContain('Saldo inicial de inventario');

      // D-713: con saldo, el piso sale del costo cargado: 3.11 ÷ (1 − margen mínimo), sin IGV.
      const margin = await minMarginPct(LINE);
      const panel = await stockPanel(api, { businessLine: LINE, productIds: [profile.id] });
      const row = panel.products.find((p) => p.productId === profile.id);
      expect(row?.minValuePen).toBe(minAllowedValue('3.1100', margin));
      const floor = await floorOf(profile.id);
      expect(floor.noFloorReason).toBeNull();
      expect(floor.minPricePen).toBe(row?.minPricePen);
      // Un precio por debajo de ese mínimo se rechaza; el de abajo (6.00) queda por encima.
      const low = await postExpectingError(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ productId: profile.id, qty: '1.000', unitPricePen: '0.50' }],
      });
      expect(low.status).toBe(400);
      expect(low.message).toMatch(/precio mínimo/);

      // D-598: con stock, la cotización del perfil confirma y reserva el propio producto, sin OP.
      const quotation = await createQuotationWithLines(api, {
        customerId: customer.id,
        businessLine: LINE,
        items: [{ productId: profile.id, qty: '30', unitPricePen: '6.0000' }],
      });
      trail.quotationIds.push(quotation.id);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      trail.orderIds.push(order.id);
      expect(order.reservations).toHaveLength(1);
      expect(order.reservations[0]).toMatchObject({
        itemType: 'PRODUCT',
        itemId: profile.id,
        qty: '30.000',
        status: 'ACTIVE',
        productionOrderId: null,
      });
    } finally {
      await purgeSalesTrail(api, trail);
      await api.patch(`/api/catalog/${profile.id}`, { data: { isActive: false } }).catch(() => {});
    }
  });
});
