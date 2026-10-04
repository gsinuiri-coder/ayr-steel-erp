import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson, postJson } from '../helpers/api';
import {
  createInvoice,
  createInvoiceableCustomer,
  getDocument,
  orderProgress,
  purgeInvoicingTrail,
  validRuc,
  type FiscalDocumentDto,
  type InvoicingTrail,
} from '../helpers/invoicing';
import { POS_LINE, setupPosStock } from '../helpers/pos';
import { balanceOf, movementsOf } from '../helpers/production';
import { createDirectOrder } from '../helpers/sales';
import { headerAction } from '../helpers/ui';

/**
 * D-381 — traer un comprobante manual anulado a otro pedido.
 *
 * El caso del dueño (FFA1-00001389): anuló el comprobante y su pedido, al que le faltaba una
 * línea, y creó el pedido correcto con una línea más. El número del anulado sigue ocupado y las
 * reactivaciones bloquean por pedido anulado. Desde el pedido nuevo se trae el comprobante: mismo
 * número y fecha, las líneas y el total del pedido nuevo, sin tocar kardex ni reservas.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea pedidos, despachos y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 240_000 });

interface OrderWithReservations {
  id: string;
  code: string;
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

interface DispatchPlan {
  lines: { lineNumber: number; action: string }[];
}

interface DispatchResult extends DispatchPlan {
  dispatchIds: string[];
}

interface Profitability {
  applies: boolean;
  uncostedSalesPen: string;
  lines: { lineNumber: number; status: string }[];
}

function uniqueCorrelative(): number {
  return Number(String(Date.now()).slice(-7));
}

/** `153.4400` → `153.44`. */
const cents = (v: string) => Number(v).toFixed(2);

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
 * El punto de partida: un manual registrado sobre un pedido de una línea, anulado, y el pedido
 * anulado también. Después, el pedido correcto con esa línea y una más.
 */
async function annulledWithCancelledOrder(api: APIRequestContext, trail: InvoicingTrail) {
  // Un RUC propio por caso: sin él, con el RUC facturable configurado (CI) el helper devuelve siempre el
  // mismo cliente, que acumula los anulados de otras corridas y de los otros tests, y «otro
  // cliente» dejaba de ser otro.
  const customer = await createInvoiceableCustomer(api, { docNumber: validRuc() });
  const stock = await setupPosStock(api, { qty: '40', unitPrice: '20' });
  trail.purchaseId = stock.purchaseId;
  trail.supplierId = stock.supplier.id;
  trail.productIds!.push(stock.product.id);

  const wrong = await createDirectOrder(api, {
    customerId: customer.id,
    businessLine: POS_LINE,
    items: [{ productId: stock.product.id, qty: '10', unitPricePen: '50.0000' }],
  });
  trail.orderIds!.push(wrong.id);
  const draft = await createInvoice(api, {
    docType: 'FACTURA',
    customerId: customer.id,
    salesOrderId: wrong.id,
    items: [{ salesOrderItemId: wrong.items[0]!.id, qty: wrong.items[0]!.qty }],
  });
  trail.documentIds!.push(draft.id);
  const correlative = uniqueCorrelative();
  const invoice = await postJson<FiscalDocumentDto>(
    api,
    `/api/invoicing/documents/${draft.id}/register-manual`,
    { series: 'F904', correlative },
  );
  // D-383: primero el comprobante y después el pedido. Con el comprobante vivo, el pedido ya no
  // se anula.
  await postJson(api, `/api/invoicing/documents/${invoice.id}/annul`, {
    reason: 'mal ingreso (E2E D-381)',
  });
  await postJson(api, `/api/sales/orders/${wrong.id}/cancel`, {
    reason: 'mal ingreso (E2E D-381)',
  });

  const right = await createDirectOrder(api, {
    customerId: customer.id,
    businessLine: POS_LINE,
    items: [
      { productId: stock.product.id, qty: '10', unitPricePen: '50.0000' },
      { productId: stock.product.id, qty: '2', unitPricePen: '50.0000' },
    ],
  });
  trail.orderIds!.push(right.id);
  return { customer, stock, wrong, right, invoice, correlative };
}

test.describe('D-381 — traer un comprobante manual anulado a otro pedido', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('anular comprobante y pedido → pedido nuevo con una línea más → traerlo: mismo número y fecha, total nuevo, saldo igual al total', async ({
    page,
  }) => {
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [],
      productIds: [],
    };
    try {
      const { customer, stock, wrong, right, invoice, correlative } =
        await annulledWithCancelledOrder(api, trail);
      const number = invoice.number ?? '';

      // Hoy no hay otro camino: el número del anulado sigue ocupado.
      const reentry = await createInvoice(api, {
        docType: 'FACTURA',
        customerId: customer.id,
        salesOrderId: right.id,
        items: right.items.map((i) => ({ salesOrderItemId: i.id, qty: i.qty })),
      });
      trail.documentIds!.push(reentry.id);
      const duplicate = await api.post(`/api/invoicing/documents/${reentry.id}/register-manual`, {
        data: { series: 'F904', correlative },
      });
      expect(duplicate.status()).toBe(409);
      // Y el borrador del intento bloquea traerlo, como en el caso real: se elimina primero.
      const byDraft = await api.get(
        `/api/invoicing/documents/${invoice.id}/move-to-order/${right.id}/preview`,
      );
      expect(byDraft.status()).toBe(409);
      expect(await byDraft.text()).toContain('borrador(es) de comprobante: elimínalo(s) primero');
      const discarded = await api.delete(`/api/invoicing/documents/${reentry.id}`, {
        data: { reason: 'intento de reingreso (E2E D-381)' },
      });
      expect(discarded.status()).toBe(204);

      const kardexBefore = await movementsOf(api, 'PRODUCT', stock.product.id);
      const balanceBefore = await balanceOf(api, 'PRODUCT', stock.product.id);
      const reservationsBefore = reservationsKey(
        await getJson<OrderWithReservations>(api, `/api/sales/orders/${right.id}`),
      );
      const paperTotal = cents(right.totalPen);

      await loginAsAdmin(page);
      await page.goto(`/pedidos/${right.id}`);
      await (await headerAction(page, 'Traer comprobante anulado')).click();
      const dialog = page.getByRole('dialog');
      // El único candidato viene elegido.
      await expect(dialog.getByTestId(`movable-${number}`)).toContainText(wrong.code);
      await expect(dialog.getByTestId('move-orders')).toHaveText(`${wrong.code} → ${right.code}`);
      await expect(dialog.getByTestId('move-warnings')).toContainText('D-374');
      await expect(dialog.getByRole('region', { name: 'Después' })).toContainText('Agregada');
      await expect(dialog.getByTestId('after-total')).toContainText(paperTotal);

      const confirm = dialog.getByRole('button', { name: 'Traer comprobante' });
      await dialog.getByLabel('Motivo').fill('Pedido con datos erróneos (E2E)');
      await dialog.getByLabel(/en este pedido, coincide con el papel vigente/).check();

      // El total viejo del papel no coincide: los dos y la diferencia, y no deja confirmar.
      const old = cents(invoice.totalPen);
      await dialog.getByLabel('Total del papel vigente (S/)').fill(old);
      await expect(dialog.getByTestId('paper-total-mismatch')).toContainText(`papel S/ ${old}`);
      await expect(confirm).toBeDisabled();

      await dialog.getByLabel('Total del papel vigente (S/)').fill(paperTotal);
      await expect(dialog.getByTestId('paper-total-mismatch')).toBeHidden();
      await confirm.click();
      await expect(page).toHaveURL(new RegExp(`/comprobantes/${invoice.id}$`), {
        timeout: 60_000,
      });

      // Mismo número y fecha, el pedido nuevo, su total y el saldo por cobrar igual al total.
      const after = await getDocument(api, invoice.id);
      expect(after.status).toBe('ACCEPTED');
      expect(after.number).toBe(number);
      expect(after.correlative).toBe(invoice.correlative);
      expect(after.issueDate).toBe(invoice.issueDate);
      expect(after.salesOrderId).toBe(right.id);
      expect(cents(after.totalPen)).toBe(paperTotal);
      expect(after.balancePen).toBe(after.totalPen);
      expect(after.items).toHaveLength(2);
      // La fila original conserva su id.
      expect(after.items.find((i) => i.lineNumber === 1)?.id).toBe(invoice.items[0]!.id);

      // P1 de la revisión: cada fila apunta a una línea del pedido nuevo.
      const rightLineIds = new Set(right.items.map((i) => i.id));
      expect(
        after.items.every((i) => i.salesOrderItemId && rightLineIds.has(i.salesOrderItemId)),
      ).toBe(true);

      // Ni kardex ni reservas.
      expect(await movementsOf(api, 'PRODUCT', stock.product.id)).toEqual(kardexBefore);
      expect(await balanceOf(api, 'PRODUCT', stock.product.id)).toEqual(balanceBefore);
      expect(
        reservationsKey(await getJson<OrderWithReservations>(api, `/api/sales/orders/${right.id}`)),
      ).toBe(reservationsBefore);

      // La facturación por línea lee el pedido nuevo: nada queda por facturar.
      const progress = await orderProgress(api, right.id);
      for (const line of progress.lines) {
        expect(line).toMatchObject({ pendingInvoiceQty: '0.000', dispatchedQty: '0.000' });
      }

      // Auditoría con origen y destino, en el comprobante y en los dos pedidos.
      const events = await getJson<{ items: AuditEvent[] }>(
        api,
        `/api/audit?entityType=fiscal_documents&entityId=${invoice.id}&pageSize=50`,
      );
      const event = events.items.find((e) => e.action === 'invoicing.document.move-to-order');
      expect(event?.reason).toBe('Pedido con datos erróneos (E2E)');
      expect(event?.before).toMatchObject({
        status: 'ANNULLED',
        salesOrderId: wrong.id,
        salesOrderCode: wrong.code,
        totalPen: invoice.totalPen,
      });
      expect(event?.after).toMatchObject({
        status: 'ACCEPTED',
        salesOrderId: right.id,
        salesOrderCode: right.code,
        paperTotalPen: paperTotal,
      });
      for (const [orderId, action] of [
        [wrong.id, 'sales.order.document-moved-out'],
        [right.id, 'sales.order.document-moved-in'],
      ] as const) {
        const orderEvents = await getJson<{ items: AuditEvent[] }>(
          api,
          `/api/audit?entityType=sales_orders&entityId=${orderId}&pageSize=50`,
        );
        expect(orderEvents.items.map((e) => e.action)).toContain(action);
      }

      // Un segundo intento ve el estado ya cambiado.
      const again = await api.post(`/api/invoicing/documents/${invoice.id}/move-to-order`, {
        data: {
          reason: 'otra vez',
          confirmMatchesPaper: true,
          paperTotalPen: paperTotal,
          targetSalesOrderId: right.id,
        },
      });
      expect(again.status()).toBe(409);

      // El despacho desde el comprobante lee el pedido nuevo: las dos líneas, y el despacho es
      // de ese pedido. En E2E la fecha del papel es hoy, así que hay stock.
      const plan = await getJson<DispatchPlan>(api, `/api/dispatches/at-issue-date/${invoice.id}`);
      expect(plan.lines.map((l) => l.action)).toEqual(['DISPATCH', 'DISPATCH']);
      const dispatched = await postJson<DispatchResult>(
        api,
        `/api/dispatches/at-issue-date/${invoice.id}`,
        {},
      );
      trail.dispatchIds!.push(...dispatched.dispatchIds);
      expect(dispatched.dispatchIds.length).toBeGreaterThan(0);
      for (const dispatchId of dispatched.dispatchIds) {
        const d = await getJson<{ salesOrderId: string }>(api, `/api/dispatches/${dispatchId}`);
        expect(d.salesOrderId).toBe(right.id);
      }
      // Y el margen del comprobante —la misma lectura por línea de pedido que los reportes de
      // ventas por material y de margen— encuentra el costo en los despachos del pedido nuevo.
      const profit = await getJson<Profitability>(
        api,
        `/api/reports/documents/${invoice.id}/profitability`,
      );
      expect(profit.applies).toBe(true);
      expect(Number(profit.uncostedSalesPen)).toBe(0);
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });

  test('bloqueos por API: pedido de otro cliente y total distinto', async () => {
    const trail: InvoicingTrail = {
      documentIds: [],
      dispatchIds: [],
      orderIds: [],
      productIds: [],
    };
    try {
      const { stock, right, invoice } = await annulledWithCancelledOrder(api, trail);
      const paperTotal = cents(right.totalPen);

      // Otro cliente: el cliente del papel no cambia (decisión 1).
      const other = await createInvoiceableCustomer(api, { docNumber: validRuc() });
      const foreign = await createDirectOrder(api, {
        customerId: other.id,
        businessLine: POS_LINE,
        items: [{ productId: stock.product.id, qty: '10', unitPricePen: '50.0000' }],
      });
      trail.orderIds!.push(foreign.id);
      const byCustomer = await api.post(`/api/invoicing/documents/${invoice.id}/move-to-order`, {
        data: {
          reason: 'otro cliente (E2E)',
          confirmMatchesPaper: true,
          paperTotalPen: cents(foreign.totalPen),
          targetSalesOrderId: foreign.id,
        },
      });
      expect(byCustomer.status()).toBe(409);
      expect(await byCustomer.text()).toContain('es de otro cliente');

      // La lista del pedido de otro cliente no lo ofrece.
      const listed = await getJson<{ id: string }[]>(
        api,
        `/api/invoicing/orders/${foreign.id}/movable-annulled-documents`,
      );
      expect(listed.map((c) => c.id)).not.toContain(invoice.id);

      // Total distinto: se rechaza con los dos y la diferencia, y no lo trae.
      const mismatch = await api.post(`/api/invoicing/documents/${invoice.id}/move-to-order`, {
        data: {
          reason: 'total distinto (E2E)',
          confirmMatchesPaper: true,
          paperTotalPen: cents(invoice.totalPen),
          targetSalesOrderId: right.id,
        },
      });
      expect(mismatch.status()).toBe(400);
      expect(await mismatch.text()).toContain(
        `no coincide con el de estas líneas (S/ ${paperTotal})`,
      );
      expect((await getDocument(api, invoice.id)).status).toBe('ANNULLED');
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });
});
