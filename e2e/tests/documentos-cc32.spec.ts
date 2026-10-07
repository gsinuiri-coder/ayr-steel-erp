import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { adminApi } from '../helpers/api';
import {
  dispatchOrder,
  fiscalEmissionAllowed,
  FISCAL_EMISSION_REASON,
  purgeInvoicingTrail,
  setupOrderScenario,
  type InvoicingTrail,
} from '../helpers/invoicing';
import {
  cashSessionSales,
  closeSessionQuietly,
  openCashSession,
  setupPosStock,
  POS_LINE,
  type CashSessionDto,
} from '../helpers/pos';
import { loginAsAdmin } from '../helpers/report-fixtures';
import { createCustomer, createQuotation, purgeSalesTrail } from '../helpers/sales';
import { headerAction } from '../helpers/ui';

/**
 * cc32 (corte 3, §2 de la espec) — documentos: imprimir sin descargar, la guía del despacho y
 * el cierre de la venta en el mostrador.
 *
 * «Imprimir» pide el mismo PDF que «Descargar», lo carga en un iframe oculto (blob) y llama a su
 * `print()`. Acá el `print()` de ese iframe se sustituye por un contador, así que «imprimió» es
 * «se llamó a print sobre el iframe con el PDF» y «no descargó» es que no hubo evento `download`.
 *
 * En local el PSE está apagado: ninguna guía ni comprobante llega a «aceptado» y el API no tiene
 * su PDF (se guarda recién con la aceptación). Los estados con guía y la venta aceptada se
 * simulan con `page.route` sobre la respuesta del API; el PDF del comprobante y de la guía
 * también. La hoja de planta y la cotización usan el PDF real del API.
 *
 * Escribe pedidos, despachos y ventas: nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea pedidos, despachos y ventas: nunca contra producción (D-126).');

test.describe.configure({ timeout: 240_000 });

/**
 * Chromium completo (headless nuevo) y no el `chromium-headless-shell` por defecto: el shell no
 * tiene visor de PDF, así que un PDF dentro de un iframe se **descarga** y el iframe nunca
 * termina de cargar — lo contrario de lo que hace el navegador del usuario. Medido en cc32:
 * con el shell, evento `download` y sin `load`; con Chromium completo, `load` con el documento
 * `application/pdf` y `print()` disponible. `playwright install chromium` instala los dos.
 */
test.use({ channel: 'chromium' });

/** Un PDF mínimo, para las rutas que el API local no puede servir (sin PSE no hay PDF). */
const FAKE_PDF =
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n%%EOF\n';

const FAKE_NOTE_ID = '00000000-0000-4000-8000-0000000c3201';

/**
 * `print()` de la ventana de un iframe con un blob suma en `__prints` y avisa `afterprint`.
 *
 * Se sustituye desde la página y no dentro del iframe: el visor de PDF del navegador no corre
 * los `addInitScript`. El doble envuelve la ventana real del iframe y solo cambia `print` (el
 * `print()` real, sin interfaz, tumba la página).
 */
async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const top = window as Window & { __prints?: number; __printed?: string[] };
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (!desc?.get) return;
    const realGet = desc.get;
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
      configurable: true,
      get(this: HTMLIFrameElement) {
        const win = realGet.call(this) as Window | null;
        if (win === null || !this.src.startsWith('blob:')) return win;
        const print = () => {
          top.__prints = (top.__prints ?? 0) + 1;
          // Qué documento tenía el iframe al imprimir: el PDF, no una página vacía.
          top.__printed = [...(top.__printed ?? []), win.document.contentType];
          setTimeout(() => {
            win.dispatchEvent(new Event('afterprint'));
          }, 50);
        };
        return new Proxy(win, {
          get(target, prop) {
            if (prop === 'print') return print;
            const value: unknown = Reflect.get(target, prop);
            return typeof value === 'function'
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      },
    });
  });
}

function printCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as Window & { __prints?: number }).__prints ?? 0);
}

/** Junta los eventos `download` de la página: imprimir no tiene que producir ninguno. */
function watchDownloads(page: Page): string[] {
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  return downloads;
}

function fulfillPdf(route: Route): Promise<void> {
  return route.fulfill({ status: 200, contentType: 'application/pdf', body: FAKE_PDF });
}

/** Imprime con `trigger` y comprueba que se llamó a `print` sin descargar nada. */
async function expectPrintsWithoutDownload(
  page: Page,
  downloads: string[],
  trigger: () => Promise<void>,
): Promise<void> {
  const before = await printCount(page);
  await trigger();
  await expect.poll(() => printCount(page), { timeout: 20_000 }).toBe(before + 1);
  const printed = await page.evaluate(
    () => (window as Window & { __printed?: string[] }).__printed ?? [],
  );
  expect(printed.at(-1)).toBe('application/pdf');
  // Al cerrar la impresión (`afterprint` del doble) el iframe se va.
  await expect(page.locator('iframe[src^="blob:"]')).toHaveCount(0);
  // Un respiro para que una descarga, si la hubiera, alcance a dispararse.
  await page.waitForTimeout(1_000);
  expect(downloads).toEqual([]);
}

test.describe('cc32 — documentos: imprimir sin descargar', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('despacho: la principal sigue el estado de la guía y «Imprimir guía» no descarga', async ({
    page,
  }) => {
    const scenario = await setupOrderScenario(api);
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [scenario.order.id],
      coilIds: [scenario.coil.id],
      purchaseId: scenario.purchaseId,
      supplierId: scenario.supplier.id,
      finish: scenario.finish,
      productIds: [scenario.product.id],
    };
    try {
      const dispatch = await dispatchOrder(api, {
        salesOrderId: scenario.order.id,
        items: [{ salesOrderItemId: scenario.item.id, qty: '100' }],
      });
      trail.dispatchIds!.push(dispatch.id);

      await stubPrint(page);
      const downloads = watchDownloads(page);
      await loginAsAdmin(page);

      // 1. Sin guía: la principal es «Emitir guía»; revertir sigue en el menú, en rojo.
      await page.goto(`/despachos/${dispatch.id}`);
      const header = page.locator('[data-slot="header-actions"]');
      await expect(header.getByRole('button', { name: 'Emitir guía', exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(header.getByRole('button', { name: 'Imprimir guía' })).toHaveCount(0);
      await header.getByRole('button', { name: 'Más opciones' }).click();
      await expect(page.getByRole('menuitem', { name: 'Revertir despacho' })).toBeVisible();
      await page.keyboard.press('Escape');

      // 2. Con la guía en envío (con número, sin aceptar): se ofrece imprimir, pero espera.
      let noteStatus = 'ISSUED';
      await page.route(`**/api/dispatches/${dispatch.id}`, async (route) => {
        const res = await route.fetch();
        const body = (await res.json()) as Record<string, unknown>;
        await route.fulfill({
          response: res,
          json: {
            ...body,
            dispatchNoteId: FAKE_NOTE_ID,
            dispatchNoteNumber: 'T001-000214',
            dispatchNoteStatus: noteStatus,
          },
        });
      });
      await page.route(`**/api/invoicing/documents/${FAKE_NOTE_ID}/pdf`, fulfillPdf);
      await page.reload();
      const waiting = header.getByRole('button', { name: 'Imprimir guía', exact: true });
      await expect(waiting).toBeDisabled({ timeout: 30_000 });
      await expect(header).toContainText('Se imprime cuando SUNAT la acepte');
      await expect(header.getByRole('button', { name: 'Emitir guía' })).toHaveCount(0);

      // 3. Con la guía aceptada: «Imprimir guía» imprime sin descargar.
      noteStatus = 'ACCEPTED';
      await page.reload();
      const print = header.getByRole('button', { name: 'Imprimir guía', exact: true });
      await expect(print).toBeEnabled({ timeout: 30_000 });
      await expect(header).not.toContainText('Se imprime cuando SUNAT la acepte');
      await expectPrintsWithoutDownload(page, downloads, () => print.click());

      // «Más opciones», en orden: descargar el PDF de la guía y verla.
      await header.getByRole('button', { name: 'Más opciones' }).click();
      await expect(page.getByRole('menuitem')).toHaveText([
        'Descargar PDF de la guía',
        'Ver la guía',
      ]);
      await expect(page.getByRole('menuitem', { name: 'Ver la guía' })).toHaveAttribute(
        'href',
        `/comprobantes/${FAKE_NOTE_ID}`,
      );
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('pedido: «Imprimir hoja de planta» imprime el PDF del API sin descargarlo', async ({
    page,
  }) => {
    const scenario = await setupOrderScenario(api);
    const trail: InvoicingTrail = {
      orderIds: [scenario.order.id],
      coilIds: [scenario.coil.id],
      purchaseId: scenario.purchaseId,
      supplierId: scenario.supplier.id,
      finish: scenario.finish,
      productIds: [scenario.product.id],
    };
    try {
      await stubPrint(page);
      const downloads = watchDownloads(page);
      await loginAsAdmin(page);
      await page.goto(`/pedidos/${scenario.order.id}`);

      const print = await headerAction(page, 'Imprimir hoja de planta');
      await expectPrintsWithoutDownload(page, downloads, () => print.click());

      // La descarga sigue existiendo, al lado.
      await page.keyboard.press('Escape');
      await expect(await headerAction(page, 'Descargar hoja de planta')).toHaveAttribute(
        'href',
        `/api/sales/orders/${scenario.order.id}/pdf-planta`,
      );
      await expect(page.getByRole('menuitem', { name: 'Hoja de planta (PDF)' })).toHaveCount(0);
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('cotización: «Imprimir» en «Más opciones» imprime sin descargar', async ({ page }) => {
    const stock = await setupPosStock(api, { qty: '5' });
    const customer = await createCustomer(api);
    const quotation = await createQuotation(api, {
      customerId: customer.id,
      businessLine: POS_LINE,
      productId: stock.product.id,
      qty: '1',
    });
    try {
      await stubPrint(page);
      const downloads = watchDownloads(page);
      await loginAsAdmin(page);
      await page.goto(`/cotizaciones/${quotation.id}`);

      const header = page.locator('[data-slot="header-actions"]');
      await expect(header.getByRole('button', { name: 'Más opciones' })).toBeVisible({
        timeout: 30_000,
      });
      // La principal sigue siendo la del estado, no «Imprimir».
      await expect(header.getByRole('button', { name: 'Imprimir', exact: true })).toHaveCount(0);
      await header.getByRole('button', { name: 'Más opciones' }).click();
      const print = page.getByRole('menuitem', { name: 'Imprimir', exact: true });
      await expectPrintsWithoutDownload(page, downloads, () => print.click());
    } finally {
      await purgeSalesTrail(api, { quotationIds: [quotation.id] });
    }
  });

  test.describe('mostrador', () => {
    test.skip(!fiscalEmissionAllowed(), FISCAL_EMISSION_REASON);

    test('al cerrar la venta, Enter imprime y el foco vuelve a «Nueva venta»', async ({ page }) => {
      const stock = await setupPosStock(api, { qty: '10', listPricePen: '50.0000' });
      let session: CashSessionDto | undefined;
      const orderIds: string[] = [];
      try {
        session = await openCashSession(api, '0.00');
        await stubPrint(page);
        const downloads = watchDownloads(page);
        await loginAsAdmin(page);

        // Sin PSE en local la venta queda pendiente: se simula la aceptación en la respuesta, y
        // el PDF, que el API no tendría.
        await page.route('**/api/pos/sales', async (route) => {
          if (route.request().method() !== 'POST') return route.fallback();
          const res = await route.fetch();
          const body = (await res.json()) as Record<string, unknown>;
          await route.fulfill({
            response: res,
            json: { ...body, fiscalDocumentStatus: 'ACCEPTED', fiscalPending: false },
          });
        });
        await page.route('**/api/invoicing/documents/*/pdf', fulfillPdf);

        await page.goto('/pos');
        await page.getByPlaceholder('Buscar por código o nombre…').fill(stock.product.sku);
        const card = page.getByRole('button', { name: new RegExp(stock.product.sku) });
        await expect(card).toBeVisible({ timeout: 30_000 });
        await card.click();
        await page.getByRole('button', { name: 'Efectivo', exact: true }).click();
        await page.getByRole('button', { name: /^Cobrar S\// }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('cerrada', { timeout: 30_000 });
        const print = dialog.getByRole('button', { name: 'Imprimir comprobante' });
        const newSale = dialog.getByRole('button', { name: 'Nueva venta' });
        await expect(dialog.getByRole('link', { name: 'Descargar PDF' })).toBeVisible();
        await expect(print).toBeFocused();

        await expectPrintsWithoutDownload(page, downloads, () => page.keyboard.press('Enter'));
        await expect(newSale).toBeFocused();

        // Otro Enter empieza la venta siguiente.
        await page.keyboard.press('Enter');
        await expect(dialog).toHaveCount(0);

        const [sale] = await cashSessionSales(api, session.id);
        if (sale) orderIds.push(sale.salesOrderId);
      } finally {
        await closeSessionQuietly(api, session?.id);
        await purgeSalesTrail(api, { orderIds });
      }
    });
  });
});
