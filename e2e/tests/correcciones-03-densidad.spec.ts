import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import { createCustomer } from '../helpers/sales';
import {
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reportPieces,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * D-294 (correcciones 03, punto 11): estilo compacto y jerarquía de secciones. Se **mide en el
 * DOM** (lección de S11): filas por pantalla de las listas y altura total de las pantallas de
 * detalle a 1366×768, más cuántas cajas con borde hay anidadas dentro de otras.
 *
 * Las cifras de la corrida se imprimen con el prefijo `DENSIDAD` (para comparar antes/después
 * en el handoff) y el spec afirma los umbrales del estilo compacto: celdas de `py-1` y ninguna
 * caja con borde dentro de otra en las cinco pantallas de detalle.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras, bobinas y pedidos: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });
test.use({ viewport: { width: 1366, height: 768 } });

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

interface ListMetrics {
  rowHeight: number;
  headTop: number;
  rowsPerScreen: number;
}

async function listMetrics(page: Page): Promise<ListMetrics> {
  return page.evaluate(() => {
    const row = document.querySelector('tbody tr:not(:has(td[colspan]))');
    const head = document.querySelector('thead');
    const rowHeight = row ? row.getBoundingClientRect().height : 0;
    const headRect = head?.getBoundingClientRect();
    const headTop = headRect ? headRect.top : 0;
    const headHeight = headRect ? headRect.height : 0;
    // La barra de paginación ocupa ~52 px al pie de la lista.
    const usable = window.innerHeight - headTop - headHeight - 52;
    return {
      rowHeight: Math.round(rowHeight * 10) / 10,
      headTop: Math.round(headTop),
      rowsPerScreen: rowHeight > 0 ? Math.floor(usable / rowHeight) : 0,
    };
  });
}

interface DetailMetrics {
  pageHeight: number;
  /** Cajas con borde/anillo dentro de otra caja con borde/anillo. */
  nestedBoxes: number;
  boxes: number;
}

async function detailMetrics(page: Page): Promise<DetailMetrics> {
  return page.evaluate(() => {
    const isBox = (el: Element) => {
      const s = getComputedStyle(el);
      const hasBorder = parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none';
      const hasRing =
        s.boxShadow !== 'none' && /ring|rgb/.test(s.boxShadow) && el.matches('[data-slot="card"]');
      const rounded = parseFloat(s.borderTopLeftRadius) > 0;
      return rounded && (hasBorder || hasRing);
    };
    const main = document.querySelector('[data-slot="sidebar-inset"]') ?? document.body;
    const all = [...main.querySelectorAll('div, section')].filter(isBox);
    const nested = all.filter((el) => all.some((other) => other !== el && other.contains(el)));
    const scroller = document.querySelector('[data-slot="sidebar-inset"]') as HTMLElement | null;
    return {
      pageHeight: scroller ? scroller.scrollHeight : document.documentElement.scrollHeight,
      nestedBoxes: nested.length,
      boxes: all.length,
    };
  });
}

test('densidad: filas por pantalla y cajas anidadas', async ({ page, baseURL }) => {
  const api = await adminApi(baseURL!);
  const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
  const customer = await createCustomer(api);
  const trail: Parameters<typeof purgeRoofingTrail>[1] = {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    productIds: [scenario.product.id],
    coilIds: [scenario.coil.id],
    purchaseIds: [scenario.purchaseId],
    orderIds: [],
    quotationIds: [],
  };
  try {
    const { quotation, order } = await quoteAndOrder(api, {
      customerId: customer.id,
      productId: scenario.product.id,
      rows: pieces([4, 3]),
    });
    trail.quotationIds = [quotation.id];
    trail.orderIds = [order.id];
    const opId = order.reservations[0]!.productionOrderId!;
    await mountCoil(api, opId, { coilId: scenario.coil.id });
    await reportPieces(api, opId, { pieces: pieces([4, 2]) });

    await loginAsAdmin(page);
    const report: Record<string, unknown> = {};

    for (const path of ['/cotizaciones', '/pedidos', '/bobinas?tab=todas']) {
      await page.goto(path);
      await expect(page.locator('thead')).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      report[`lista ${path}`] = await listMetrics(page);
    }

    const details: [string, string][] = [
      ['cotización', `/cotizaciones/${quotation.id}`],
      ['pedido', `/pedidos/${order.id}`],
      ['bobina', `/bobinas/${scenario.coil.id}`],
      ['OP', `/produccion/${opId}`],
    ];
    for (const [name, path] of details) {
      await page.goto(path);
      await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 60_000 });
      await page.waitForTimeout(2000);
      report[`detalle ${name}`] = await detailMetrics(page);
      // Captura para la revisión visual (queda en test-results/, que no se versiona).
      await page.screenshot({ path: `test-results/densidad-${name}.png` });
    }
    console.log(`DENSIDAD ${JSON.stringify(report)}`);

    // Umbrales del estilo compacto (D-294).
    const lists = Object.entries(report).filter(([k]) => k.startsWith('lista '));
    for (const [name, value] of lists) {
      const m = value as ListMetrics;
      expect(m.rowHeight, `${name}: alto de fila`).toBeGreaterThan(0);
      expect(m.rowHeight, `${name}: alto de fila (celdas py-1)`).toBeLessThanOrEqual(29);
    }
    for (const [name, value] of Object.entries(report).filter(([k]) => k.startsWith('detalle '))) {
      expect((value as DetailMetrics).nestedBoxes, `${name}: cajas con borde anidadas`).toBe(0);
      // Solo lo realmente independiente queda enmarcado (un aviso de negocio, una tarjeta propia).
      expect((value as DetailMetrics).boxes, `${name}: cajas con borde`).toBeLessThanOrEqual(1);
    }
  } finally {
    await purgeRoofingTrail(api, trail);
    await api.dispose();
  }
});
