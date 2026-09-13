import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import {
  metersOf,
  pieces,
  purgeRoofingTrail,
  ROOFING_LINE,
  setupRoofingScenario,
  type RoofingScenario,
} from '../helpers/roofing';
import { createCustomer, createQuotation, type QuotationDto } from '../helpers/sales';

/**
 * F8-S2b/M1 — el aviso "sin stock disponible" (D-188).
 *
 * Reusa exactamente el cálculo de `confirmPreview` (`previewLinesOf`): sin flag guardado ni
 * job, una cotización aparece o deja de aparecer según lo que la lectura de hoy calcule, no
 * según lo que alguien haya marcado ayer. Geometría de prueba: 4.04 kg/m (D-165), así que una
 * línea de 10 m son 40.400 kg.
 */

interface StockShortage {
  quotationId: string;
  quotationCode: string;
  customerName: string;
  lines: {
    lineNumber: number;
    productSku: string;
    label: string;
    missingQty: string;
    unit: string;
  }[];
}

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea datos comerciales: nunca contra producción (D-126, regla dura 9).');
test.describe.configure({ timeout: 120_000 });

function trailOf(s: RoofingScenario) {
  return {
    supplierId: s.supplier.id,
    finishId: s.finish.id,
    colorId: s.color.id,
    productIds: [s.product.id],
    coilIds: [s.coil.id],
    purchaseIds: [s.purchaseId],
    orderIds: [] as string[],
    quotationIds: [] as string[],
  };
}

async function shortages(api: APIRequestContext): Promise<StockShortage[]> {
  return getJson<StockShortage[]>(api, '/api/sales/quotations/stock-shortages');
}

test.describe('F8-S2b/M1 — cotizaciones sin stock disponible (D-188)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('D-188: aparece con lo que falta cuando otra reserva se llevó el material, y desaparece sola al liberarse', async () => {
    const s = await setupRoofingScenario(api, { weightKg: '100' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 2]); // 80.800 kg
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);

      // Sin nadie más compitiendo por el agregado, no tiene nada de qué avisar.
      expect((await shortages(api)).some((r) => r.quotationId === quotation.id)).toBe(false);

      // Un rival se lleva 40.400 kg con reserva temporal: a esta le faltan 21.200.
      const rivalRows = pieces([10, 1]);
      const rival = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rivalRows),
        unitPricePen: '60',
        pieces: rivalRows,
      });
      trail.quotationIds.push(rival.id);
      await postJson(api, `/api/sales/quotations/${rival.id}/reserve`);

      const short = await shortages(api);
      const entry = short.find((r) => r.quotationId === quotation.id);
      expect(entry, 'la cotización sin stock aparece en el aviso').toBeDefined();
      expect(entry).toMatchObject({ quotationCode: quotation.code, customerName: customer.name });
      expect(entry!.lines).toEqual([
        expect.objectContaining({ lineNumber: 1, missingQty: '21.200' }),
      ]);
      // El rival, con lo suyo cubierto, no tiene nada que avisar.
      expect(short.some((r) => r.quotationId === rival.id)).toBe(false);

      // Se libera el rival: sin flag que limpiar ni job que corra, la próxima lectura ya no
      // la cuenta — es la misma cuenta, sobre datos que cambiaron.
      await postJson(api, `/api/sales/quotations/${rival.id}/release-reservation`, {
        reason: 'El rival no depositó',
      });
      expect((await shortages(api)).some((r) => r.quotationId === quotation.id)).toBe(false);

      // Y confirmarla la saca del alcance de la consulta (ya no está EMITTED), aunque
      // volviera a faltar material después.
      const confirmed = await postJson<{ status: string }>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
      );
      expect(confirmed.status).toBe('CONFIRMED');
      trail.orderIds.push(
        (await getJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}`)).salesOrderId!,
      );
      expect((await shortages(api)).some((r) => r.quotationId === quotation.id)).toBe(false);
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('D-188: el Panel muestra la tarjeta con lo que falta, y navega a la cotización', async ({
    page,
  }) => {
    const s = await setupRoofingScenario(api, { weightKg: '100' });
    const customer = await createCustomer(api);
    const trail = trailOf(s);
    try {
      const rows = pieces([10, 2]); // 80.800 kg
      const quotation = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rows),
        unitPricePen: '60',
        pieces: rows,
      });
      trail.quotationIds.push(quotation.id);

      const rivalRows = pieces([10, 1]);
      const rival = await createQuotation(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: s.product.id,
        qty: metersOf(rivalRows),
        unitPricePen: '60',
        pieces: rivalRows,
      });
      trail.quotationIds.push(rival.id);
      await postJson(api, `/api/sales/quotations/${rival.id}/reserve`);

      await loginAsAdmin(page);
      // La tarjeta ES el aviso (sin campana, sin correo): tiene que estar en el Panel mismo.
      await expect(page.getByText('Cotizaciones sin stock disponible')).toBeVisible({
        timeout: 30_000,
      });
      const row = page.getByRole('link', { name: new RegExp(quotation.code) });
      await expect(row).toBeVisible();
      await expect(row.getByText(/faltan 21\.200/)).toBeVisible();

      await row.click();
      await expect(page).toHaveURL(new RegExp(`/cotizaciones/${quotation.id}$`));
      await expect(page.getByRole('heading', { name: quotation.code, level: 1 })).toBeVisible();
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });
});

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}
