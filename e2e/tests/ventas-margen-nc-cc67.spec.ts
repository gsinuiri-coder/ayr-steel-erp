import { expect, test, type APIRequestContext } from '@playwright/test';
import { toDecimal, type SalesMarginDto } from '@ayr/shared';
import { adminApi, getJson, postJson } from '../helpers/api';
import {
  createInvoice,
  dispatchOrder,
  purgeInvoicingTrail,
  setupOrderScenario,
} from '../helpers/invoicing';
import { today } from '../helpers/production';
import { firstOfMonth, loginAsAdmin, previousMonth } from '../helpers/report-fixtures';

/**
 * cc67 (D-720) — **las notas de crédito aparte en Ventas y margen.** Una factura del mes anterior
 * con su NC de devolución en este mes, y una factura de este mes con su NC de descuento. Se mira:
 *
 * - el mes de la factura no cambia con la NC (D-647);
 * - la NC resta en su mes: la devolución, venta y costo; el descuento, solo venta;
 * - netas = los totales de siempre y brutas + NC = netas, al céntimo;
 * - la franja muestra brutas, NC y netas, y el modal lista las NC con sus enlaces y la marca del
 *   comprobante de un mes anterior;
 * - sin NC en el periodo, la franja queda como siempre.
 *
 * Bobinas vendidas enteras (setupOrderScenario), despachadas y facturadas a mano.
 */

const allowWrites = process.env.E2E_ALLOW_WRITES === '1' || !process.env.E2E_BASE_URL;

test.describe.configure({ timeout: 240_000 });

const series = () => `F${String(Math.floor(Math.random() * 900) + 100)}`;
const correlative = () => Math.floor(Math.random() * 90_000_000) + 1_000_000;

interface Sold {
  invoiceId: string;
  invoiceNumber: string;
  itemId: string;
  itemQty: string;
  orderId: string;
  coilId: string;
}

async function sell(api: APIRequestContext, issueDate: string): Promise<Sold> {
  const scenario = await setupOrderScenario(api, { coilKg: '1000' });
  await dispatchOrder(api, {
    salesOrderId: scenario.order.id,
    items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
  });
  const draft = await createInvoice(api, {
    docType: 'FACTURA',
    customerId: scenario.customer.id,
    salesOrderId: scenario.order.id,
    issueDate,
    items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
  });
  const invoice = await postJson<{
    id: string;
    number: string;
    items: { id: string; qty: string }[];
  }>(api, `/api/invoicing/documents/${draft.id}/register-manual`, {
    series: series(),
    correlative: correlative(),
  });
  const [item] = invoice.items;
  if (!item) throw new Error('La factura no trae su línea');
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    itemId: item.id,
    itemQty: item.qty,
    orderId: scenario.order.id,
    coilId: scenario.coil.id,
  };
}

function margin(api: APIRequestContext, from: string, to: string): Promise<SalesMarginDto> {
  return getJson<SalesMarginDto>(api, `/api/reports/sales-margin?from=${from}&to=${to}`);
}

test.describe('cc67 — notas de crédito aparte en Ventas y margen (D-720)', () => {
  test.skip(!allowWrites, 'Vende, despacha y factura: nunca contra producción (D-126).');

  let api: APIRequestContext;
  const orderIds: string[] = [];
  const coilIds: string[] = [];
  const documentIds: string[] = [];

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await purgeInvoicingTrail(api, { orderIds, coilIds, documentIds }).catch(() => undefined);
    await api.dispose();
  });

  test('la NC resta en su mes, aparte, y el mes del comprobante no cambia', async ({ page }) => {
    const now = today();
    const prev = previousMonth(now);
    const month = { from: firstOfMonth(now), to: now };

    const old = await sell(api, prev.to);
    const fresh = await sell(api, now);
    for (const s of [old, fresh]) {
      orderIds.push(s.orderId);
      coilIds.push(s.coilId);
      documentIds.push(s.invoiceId);
    }

    const prevRow = (r: SalesMarginDto) => r.orders.find((o) => o.salesOrderId === old.orderId);
    const before = prevRow(await margin(api, prev.from, prev.to));
    expect(before?.costPen).not.toBeNull();

    // NC 07 por toda la línea de la factura del mes anterior (la bobina vuelve con su DEV-) y NC 04
    // de S/ 11.80 con IGV sobre la de este mes.
    const ncReturn = await postJson<{ id: string; number: string }>(
      api,
      `/api/invoicing/documents/${old.invoiceId}/credit-note/register`,
      {
        reason: 'DEVOLUCION_ITEM',
        issueDate: now,
        series: series(),
        correlative: correlative(),
        items: [{ affectedItemId: old.itemId, qty: old.itemQty }],
      },
    );
    const ncDiscount = await postJson<{ id: string; number: string }>(
      api,
      `/api/invoicing/documents/${fresh.invoiceId}/credit-note/register`,
      {
        reason: 'DESCUENTO_GLOBAL',
        issueDate: now,
        series: series(),
        correlative: correlative(),
        amountPen: '11.80',
      },
    );
    documentIds.push(ncReturn.id, ncDiscount.id);

    // El mes del comprobante queda igual (D-647).
    expect(prevRow(await margin(api, prev.from, prev.to))).toEqual(before);

    // En este mes, la NC aparte, con su efecto.
    const current = await margin(api, month.from, month.to);
    const byId = new Map(current.creditNotes.map((n) => [n.id, n]));
    const ret = byId.get(ncReturn.id);
    const disc = byId.get(ncDiscount.id);
    expect(ret).toMatchObject({
      reason: 'DEVOLUCION_ITEM',
      affectedDocumentId: old.invoiceId,
      affectedNumber: old.invoiceNumber,
      affectedIssueDate: prev.to,
      affectedEarlierMonth: true,
      inTotals: true,
    });
    // La devolución resta la venta de la factura y el costo con que salió la bobina.
    expect(ret?.salesPen).toBe(toDecimal(before!.salesPen).negated().toFixed(4));
    expect(ret?.costPen).toBe(toDecimal(before!.costPen!).negated().toFixed(4));
    expect(disc).toMatchObject({
      reason: 'DESCUENTO_GLOBAL',
      affectedEarlierMonth: false,
      salesPen: '-10.0000',
      costPen: '0.0000',
      marginPen: '-10.0000',
    });

    // Netas = los totales de siempre, y brutas + NC = netas.
    const c = current.creditTotals;
    const t = current.totals;
    expect([c.netSalesPen, c.netCostPen, c.netMarginPen]).toEqual([
      t.salesPen,
      t.costPen,
      t.marginPen,
    ]);
    expect(toDecimal(c.grossSalesPen).plus(c.creditSalesPen).toFixed(4)).toBe(t.salesPen);
    expect(toDecimal(c.grossCostPen).plus(c.creditCostPen).toFixed(4)).toBe(t.costPen);
    expect(toDecimal(c.grossMarginPen).plus(c.creditMarginPen).toFixed(4)).toBe(t.marginPen);
    // Por fecha, de la más antigua a la más reciente.
    const dates = current.creditNotes.map((n) => n.issueDate);
    expect(dates).toEqual([...dates].sort());

    // La pantalla: brutas, NC y netas debajo de la franja, y el modal.
    await loginAsAdmin(page);
    await page.goto(`/reportes/ventas-margen?from=${month.from}&to=${month.to}`);
    const summary = page.getByTestId('nc-ventas-margen');
    await expect(summary).toBeVisible({ timeout: 60_000 });
    await expect(summary.getByTestId('nc-fila-brutas')).toBeVisible();
    await expect(summary.getByTestId('nc-fila-nc')).toBeVisible();
    await expect(summary.getByTestId('nc-fila-netas')).toBeVisible();
    await summary.getByRole('button', { name: /^Ver (la nota|las \d+ notas) de crédito$/ }).click();

    const dialog = page.getByTestId('modal-notas-credito');
    await expect(dialog).toBeVisible();
    // El buscar va primero.
    const search = dialog.getByRole('searchbox', { name: 'Buscar notas de crédito' });
    await search.fill(ncReturn.number);
    const rows = dialog.getByTestId('fila-nota-credito');
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row.getByRole('link', { name: ncReturn.number })).toHaveAttribute(
      'href',
      `/comprobantes/${ncReturn.id}`,
    );
    await expect(row.getByRole('link', { name: old.invoiceNumber })).toHaveAttribute(
      'href',
      `/comprobantes/${old.invoiceId}`,
    );
    await expect(row.getByTestId('nc-mes-anterior')).toBeVisible();
    await expect(row).toContainText('07 · Devolución por ítem');

    await search.fill(ncDiscount.number);
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId('nc-mes-anterior')).toHaveCount(0);
    await expect(rows.first()).toContainText('04 · Descuento global');

    // Sin scroll horizontal en el modal: se mide el contenedor propio de la tabla (el que tiene
    // `overflow-x-auto`), no el de fuera, que nunca desborda (segundo modelo, P2-1).
    const overflow = await dialog.getByTestId('tabla-notas-credito').evaluate((t) => {
      const box = t.closest('[data-slot="table-container"]');
      if (box === null) throw new Error('La tabla no está en su contenedor');
      return box.scrollWidth - box.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('sin NC en el periodo, la franja queda como siempre', async ({ page }) => {
    // El periodo sin NC se arma sobre la respuesta real: lo que se prueba es la pantalla.
    await page.route('**/api/reports/sales-margin?*', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as SalesMarginDto;
      await route.fulfill({ response, json: { ...body, creditNotes: [] } });
    });
    const now = today();
    await loginAsAdmin(page);
    await page.goto(`/reportes/ventas-margen?from=${firstOfMonth(now)}&to=${now}`);
    await expect(page.getByTestId('cifras-ventas-margen')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('nc-ventas-margen')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /notas? de crédito/ })).toHaveCount(0);
  });
});
