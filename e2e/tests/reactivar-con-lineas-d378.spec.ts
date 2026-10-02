import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import {
  createInvoice,
  createInvoiceableCustomer,
  dispatchOrder,
  getDocument,
  orderProgress,
  purgeInvoicingTrail,
  type FiscalDocumentDto,
  type InvoicingTrail,
} from '../helpers/invoicing';
import { POS_LINE, setupPosStock } from '../helpers/pos';
import { balanceOf, movementsOf } from '../helpers/production';
import { createDirectOrder, patchExpectingError } from '../helpers/sales';

/**
 * D-378 — reactivar un comprobante manual anulado con las líneas actuales del pedido.
 *
 * El caso del dueño: el papel está bien y al pedido le faltó un ítem. Con el comprobante anulado
 * se agrega el ítem al pedido y se reactiva reemplazando sus líneas por las del pedido entero,
 * con el mismo número. Solo si el total del papel tipeado coincide al céntimo. No mueve kardex ni
 * reservas: la línea original conserva su despacho y la agregada queda pendiente.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea pedidos, despachos y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

interface ReactivationSide {
  lines: { lineNumber: number; orderLineNumber: number; qty: string; added: boolean }[];
  subtotalPen: string;
  igvPen: string;
  totalPen: string;
}

interface ReactivationPreview {
  number: string | null;
  salesOrderCode: string;
  before: ReactivationSide;
  after: ReactivationSide;
}

interface OrderWithReservations {
  id: string;
  totalPen: string;
  items: { id: string; lineNumber: number; qty: string }[];
  reservations: { id: string; status: string; qty: string; salesOrderItemId: string }[];
}

interface AuditEvent {
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

function uniqueCorrelative(): number {
  return Number(String(Date.now()).slice(-7));
}

/** `153.4400` → `153.44`. */
const cents = (v: string) => Number(v).toFixed(2);

const previewOf = (api: APIRequestContext, id: string) =>
  getJson<ReactivationPreview>(
    api,
    `/api/invoicing/documents/${id}/reactivate-with-order-lines/preview`,
  );

const reservationsKey = (o: OrderWithReservations) =>
  [...o.reservations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `${r.id}:${r.status}:${r.qty}`)
    .join('|');

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

/**
 * Un pedido de un producto con stock propio, con su línea 1 facturada en un manual registrado,
 * **despachada** y anulada. Es el punto de partida de los dos casos.
 */
async function annulledWithDispatchedLine(api: APIRequestContext, trail: InvoicingTrail) {
  const customer = await createInvoiceableCustomer(api);
  const stock = await setupPosStock(api, { qty: '40', unitPrice: '20' });
  trail.purchaseId = stock.purchaseId;
  trail.supplierId = stock.supplier.id;
  trail.productIds!.push(stock.product.id);
  const order = await createDirectOrder(api, {
    customerId: customer.id,
    businessLine: POS_LINE,
    items: [{ productId: stock.product.id, qty: '10', unitPricePen: '50.0000' }],
  });
  trail.orderIds!.push(order.id);
  const line1 = order.items[0]!;

  const draft = await createInvoice(api, {
    docType: 'FACTURA',
    customerId: customer.id,
    salesOrderId: order.id,
    items: [{ salesOrderItemId: line1.id, qty: line1.qty }],
  });
  trail.documentIds!.push(draft.id);
  const invoice = await postJson<FiscalDocumentDto>(
    api,
    `/api/invoicing/documents/${draft.id}/register-manual`,
    { series: 'F903', correlative: uniqueCorrelative() },
  );
  // En NIU la guía pide el peso en kilos.
  const dispatch = await dispatchOrder(api, {
    salesOrderId: order.id,
    items: [{ salesOrderItemId: line1.id, qty: line1.qty, weightKg: '25' }],
  });
  trail.dispatchIds!.push(dispatch.id);
  await postJson(api, `/api/invoicing/documents/${invoice.id}/annul`, {
    reason: 'faltó un ítem (E2E D-378)',
  });
  return { customer, stock, order, line1, invoice };
}

test.describe('D-378 — reactivar con las líneas actuales del pedido', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('agregar el ítem al pedido y reactivar desde el menú: mismo número, total del papel, sin tocar kardex ni reservas', async ({
    page,
  }) => {
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [],
      productIds: [],
    };
    try {
      const { stock, order, line1, invoice } = await annulledWithDispatchedLine(api, trail);
      const number = invoice.number ?? '';

      // D-187 sigue mandando con el comprobante anulado: la línea despachada no cambia de
      // cantidad.
      const qty = await patchExpectingError(
        api,
        `/api/sales/orders/${order.id}/items/${line1.id}/qty`,
        { qty: '12' },
      );
      expect(qty.status).toBe(400);
      expect(qty.message).toContain('ya tiene despachos, así que su cantidad no se cambia');

      // Lo que faltó en el pedido: dos unidades más del mismo producto, como línea 2.
      const grown = await postJson<OrderWithReservations>(
        api,
        `/api/sales/orders/${order.id}/items`,
        { items: [{ productId: stock.product.id, qty: '2', unitPricePen: '50.0000' }] },
      );
      expect(grown.items).toHaveLength(2);

      const kardexBefore = await movementsOf(api, 'PRODUCT', stock.product.id);
      const balanceBefore = await balanceOf(api, 'PRODUCT', stock.product.id);
      const reservationsBefore = reservationsKey(
        await getJson<OrderWithReservations>(api, `/api/sales/orders/${order.id}`),
      );

      // La vista previa: el antes es el papel viejo y el después, el pedido entero.
      const preview = await previewOf(api, invoice.id);
      expect(preview.number).toBe(number);
      expect(preview.before.lines).toHaveLength(1);
      expect(preview.before.totalPen).toBe(invoice.totalPen);
      expect(preview.after.lines.map((l) => [l.orderLineNumber, l.added])).toEqual([
        [1, false],
        [2, true],
      ]);
      // El total nuevo es el del pedido (D-377), que es lo que dice el papel corregido.
      expect(preview.after.totalPen).toBe(grown.totalPen);
      const paperTotal = cents(preview.after.totalPen);

      await loginAsAdmin(page);
      await page.goto(`/comprobantes?status=VOIDED,ANNULLED&search=${encodeURIComponent(number)}`);
      await page.getByRole('button', { name: `Más acciones de ${number}` }).click();
      await page.getByRole('menuitem', { name: 'Reactivar con las líneas del pedido' }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('region', { name: 'Antes' })).toContainText(
        cents(invoice.totalPen),
      );
      await expect(dialog.getByRole('region', { name: 'Después' })).toContainText('Agregada');
      await expect(dialog.getByTestId('after-total')).toContainText(paperTotal);

      const confirm = dialog.getByRole('button', { name: 'Reactivar con estas líneas' });
      await dialog.getByLabel('Motivo de la reactivación').fill('Faltó un ítem (E2E)');
      await dialog.getByLabel(/coincide con el papel vigente/).check();

      // Un total que no coincide: los dos valores y la diferencia, y no deja confirmar.
      const wrong = (Number(paperTotal) + 0.01).toFixed(2);
      await dialog.getByLabel('Total del papel vigente (S/)').fill(wrong);
      const mismatch = dialog.getByTestId('paper-total-mismatch');
      await expect(mismatch).toContainText(`papel S/ ${wrong}`);
      await expect(mismatch).toContainText(`estas líneas S/ ${paperTotal}`);
      await expect(mismatch).toContainText('diferencia S/ 0.01');
      await expect(confirm).toBeDisabled();

      await dialog.getByLabel('Total del papel vigente (S/)').fill(paperTotal);
      await expect(mismatch).toBeHidden();
      await confirm.click();
      await expect(page).toHaveURL(new RegExp(`/comprobantes/${invoice.id}\\?despacho=`), {
        timeout: 60_000,
      });

      const after = await getDocument(api, invoice.id);
      expect(after.status).toBe('ACCEPTED');
      expect(after.number).toBe(number);
      expect(after.correlative).toBe(invoice.correlative);
      expect(after.issueDate).toBe(invoice.issueDate);
      expect(after.items).toHaveLength(2);
      expect(after.items.find((i) => i.lineNumber === 1)?.id).toBe(invoice.items[0]!.id);
      expect(cents(after.totalPen)).toBe(paperTotal);
      // El saldo por cobrar es el total nuevo.
      expect(after.balancePen).toBe(after.totalPen);

      // Ni kardex ni reservas.
      expect(await movementsOf(api, 'PRODUCT', stock.product.id)).toEqual(kardexBefore);
      expect(await balanceOf(api, 'PRODUCT', stock.product.id)).toEqual(balanceBefore);
      expect(
        reservationsKey(await getJson<OrderWithReservations>(api, `/api/sales/orders/${order.id}`)),
      ).toBe(reservationsBefore);

      // La línea original conserva su despacho; la agregada queda facturada y pendiente.
      const progress = await orderProgress(api, order.id);
      const byLine = new Map(progress.lines.map((l) => [l.lineNumber, l]));
      expect(byLine.get(1)).toMatchObject({ dispatchedQty: '10.000', pendingInvoiceQty: '0.000' });
      expect(byLine.get(2)).toMatchObject({
        dispatchedQty: '0.000',
        pendingDispatchQty: '2.000',
        pendingInvoiceQty: '0.000',
      });

      // Auditoría con el antes y el después.
      const events = await getJson<{ items: AuditEvent[] }>(
        api,
        `/api/audit?entityType=fiscal_documents&entityId=${invoice.id}&pageSize=50`,
      );
      const event = events.items.find(
        (e) => e.action === 'invoicing.document.reactivate-with-order-lines',
      );
      expect(event?.reason).toBe('Faltó un ítem (E2E)');
      expect(event?.before).toMatchObject({
        status: 'ANNULLED',
        annulReason: 'faltó un ítem (E2E D-378)',
        totalPen: invoice.totalPen,
      });
      expect(event?.after).toMatchObject({
        status: 'ACCEPTED',
        paperTotalPen: paperTotal,
        confirmedMatchesPaper: true,
      });

      // Un segundo intento ve el estado ya cambiado.
      const again = await api.post(
        `/api/invoicing/documents/${invoice.id}/reactivate-with-order-lines`,
        { data: { reason: 'otra vez', confirmMatchesPaper: true, paperTotalPen: paperTotal } },
      );
      expect(again.status()).toBe(409);
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('borrador u otro comprobante vivo en el pedido bloquean con mensaje claro; el total distinto se rechaza en el API', async () => {
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [],
      productIds: [],
    };
    try {
      const { customer, stock, order, invoice } = await annulledWithDispatchedLine(api, trail);
      const grown = await postJson<OrderWithReservations>(
        api,
        `/api/sales/orders/${order.id}/items`,
        { items: [{ productId: stock.product.id, qty: '2', unitPricePen: '50.0000' }] },
      );
      const line2 = grown.items.find((i) => i.lineNumber === 2)!;
      const paperTotal = cents(grown.totalPen);
      const body = {
        reason: 'Faltó un ítem (E2E)',
        confirmMatchesPaper: true,
        paperTotalPen: paperTotal,
      };
      const url = `/api/invoicing/documents/${invoice.id}/reactivate-with-order-lines`;

      // Un borrador sobre la línea agregada.
      const draft = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: order.id,
        items: [{ salesOrderItemId: line2.id, qty: line2.qty }],
      });
      trail.documentIds!.push(draft.id);
      const byDraft = await api.post(url, { data: body });
      expect(byDraft.status()).toBe(409);
      expect(await byDraft.text()).toContain('borrador(es) de comprobante: elimínalo(s) primero');
      const previewByDraft = await api.get(`${url}/preview`);
      expect(previewByDraft.status()).toBe(409);

      // Registrado, es otro comprobante vivo del pedido y se nombra.
      const other = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${draft.id}/register-manual`,
        { series: 'F903', correlative: uniqueCorrelative() + 1 },
      );
      const byOther = await api.post(url, { data: body });
      expect(byOther.status()).toBe(409);
      expect(await byOther.text()).toContain(`tiene otro comprobante vivo (${other.number ?? ''})`);

      // Sin el otro, pasa la vista previa; el total distinto se rechaza con los dos y la
      // diferencia, y no reactiva.
      await postJson(api, `/api/invoicing/documents/${other.id}/annul`, {
        reason: 'limpieza del caso (E2E D-378)',
      });
      const wrong = (Number(paperTotal) - 1).toFixed(2);
      const mismatch = await api.post(url, { data: { ...body, paperTotalPen: wrong } });
      expect(mismatch.status()).toBe(400);
      expect(await mismatch.text()).toContain(
        `El total del papel (S/ ${wrong}) no coincide con el de estas líneas (S/ ${paperTotal}): diferencia S/ -1.00`,
      );
      expect((await getDocument(api, invoice.id)).status).toBe('ANNULLED');

      // La reactivación simple de D-373 no cambia: agregar un ítem no edita las líneas que el
      // comprobante factura, así que reactiva con su línea y su total de siempre.
      const simple = await postJson<FiscalDocumentDto>(
        api,
        `/api/invoicing/documents/${invoice.id}/reactivate`,
        { reason: 'Anulado por error (E2E)', confirmStillValid: true },
      );
      expect(simple.status).toBe('ACCEPTED');
      expect(simple.items).toHaveLength(1);
      expect(simple.totalPen).toBe(invoice.totalPen);
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });
});
