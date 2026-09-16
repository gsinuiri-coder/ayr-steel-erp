import { randomUUID } from 'node:crypto';
import { expect, request, test } from '@playwright/test';
import { adminApi, createUser, getJson } from '../helpers/api';
import {
  createInvoiceableCustomer,
  dispatchOrder,
  freeLine,
  invoiceBody,
  setupOrderScenario,
} from '../helpers/invoicing';

/**
 * HOTFIX-401/M2 — PED-000006 en producción tenía 3 borradores por el total completo, cada
 * uno mostrando saldo y "Vencido". No había idempotencyKey, ni tope contra el total del
 * pedido, ni exclusión de `DRAFT` del saldo/vencido. Los cuatro escenarios de cierre que
 * pedía el brief.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea comprobantes y pedidos: nunca contra producción (D-126).');

test.describe('Sin idempotencyKey, no hay guardrail nuevo (compatibilidad)', () => {
  test('crear dos borradores sueltos, sin clave, sigue creando dos documentos', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const body = invoiceBody({
      docType: 'FACTURA',
      customerId: customer.id,
      items: [freeLine('1', '10.0000')],
    });
    const r1 = await api.post('/api/invoicing/documents', { data: body });
    const r2 = await api.post('/api/invoicing/documents', { data: body });
    expect(r1.ok()).toBeTruthy();
    expect(r2.ok()).toBeTruthy();
    const d1 = (await r1.json()) as { id: string };
    const d2 = (await r2.json()) as { id: string };
    expect(d1.id).not.toBe(d2.id);
  });
});

test.describe('Doble click / reintento con la misma clave de idempotencia', () => {
  test('la misma idempotencyKey dos veces devuelve el mismo borrador, no crea un segundo', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const idempotencyKey = randomUUID();
    const body = {
      ...invoiceBody({
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('1', '10.0000')],
      }),
      idempotencyKey,
    };
    const r1 = await api.post('/api/invoicing/documents', { data: body });
    const r2 = await api.post('/api/invoicing/documents', { data: body });
    expect(r1.ok()).toBeTruthy();
    expect(r2.ok()).toBeTruthy();
    const d1 = (await r1.json()) as { id: string };
    const d2 = (await r2.json()) as { id: string };
    expect(d2.id).toBe(d1.id);

    const list = await getJson<{ items: { id: string }[] }>(
      api,
      `/api/invoicing/documents?customerId=${customer.id}`,
    );
    expect(list.items.filter((d) => d.id === d1.id)).toHaveLength(1);
  });
});

test.describe('Tope: no se factura más del total del pedido', () => {
  test('un segundo borrador que ya cubre el total del pedido se rechaza con 400', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupOrderScenario(api);
    const body = invoiceBody({
      docType: 'FACTURA',
      customerId: scenario.customer.id,
      salesOrderId: scenario.order.id,
      items: [
        {
          salesOrderItemId: scenario.item.id,
          qty: scenario.item.qty,
          unitPricePen: '8.0000',
        },
      ],
    });
    const first = await api.post('/api/invoicing/documents', { data: body });
    expect(
      first.ok(),
      'el primer borrador por el total del pedido se crea sin problema',
    ).toBeTruthy();

    const second = await api.post('/api/invoicing/documents', { data: body });
    expect(second.status()).toBe(400);
    const err = (await second.json()) as { message: string };
    expect(err.message).toContain('ya tiene');
  });

  test('un borrador con despacho declarado no cuenta dos veces contra el mismo despacho', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupOrderScenario(api);
    const dispatch = await dispatchOrder(api, {
      salesOrderId: scenario.order.id,
      items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
    });
    const body = {
      ...invoiceBody({
        docType: 'FACTURA',
        customerId: scenario.customer.id,
        salesOrderId: scenario.order.id,
        items: [
          {
            salesOrderItemId: scenario.item.id,
            qty: scenario.item.qty,
            unitPricePen: '8.0000',
          },
        ],
      }),
      dispatchId: dispatch.id,
    };
    const first = await api.post('/api/invoicing/documents', { data: body });
    expect(first.ok()).toBeTruthy();

    const second = await api.post('/api/invoicing/documents', { data: body });
    // El guard de D-205 (409) solo mira despachos enlazados a un comprobante **vivo**
    // (`LIVE_DOCUMENT_STATUSES`, que no incluye `DRAFT`) — un borrador sin emitir no lo
    // dispara. El tope de M2 sí: es el que corta acá, con el mismo código que el caso
    // sin despacho.
    expect(second.status()).toBe(400);
    const err = (await second.json()) as { message: string };
    expect(err.message).toContain('ya tiene');
  });
});

test.describe('Un borrador no es una deuda', () => {
  test('un borrador recién creado no tiene saldo y no aparece en "Solo con saldo"', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const res = await api.post('/api/invoicing/documents', {
      data: invoiceBody({
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('1', '100.0000')],
      }),
    });
    expect(res.ok()).toBeTruthy();
    const draft = (await res.json()) as { id: string; balancePen: string; isOverdue: boolean };
    expect(draft.balancePen).toBe('0.0000');
    expect(draft.isOverdue).toBe(false);

    const pending = await getJson<{ items: { id: string }[] }>(
      api,
      '/api/invoicing/documents?pendingOnly=true',
    );
    expect(pending.items.some((d) => d.id === draft.id)).toBe(false);
  });
});

test.describe('Descartar un borrador exige un motivo', () => {
  test('sin motivo, 400; con motivo, se descarta', async ({ baseURL }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const res = await api.post('/api/invoicing/documents', {
      data: invoiceBody({
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('1', '10.0000')],
      }),
    });
    const draft = (await res.json()) as { id: string };

    const withoutReason = await api.delete(`/api/invoicing/documents/${draft.id}`, { data: {} });
    expect(withoutReason.status()).toBe(400);

    const withReason = await api.delete(`/api/invoicing/documents/${draft.id}`, {
      data: { reason: 'Prueba E2E: motivo obligatorio (HOTFIX-401)' },
    });
    expect(withReason.status()).toBe(204);
  });

  test('otro vendedor no puede descartar el borrador ajeno', async ({ baseURL }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const res = await api.post('/api/invoicing/documents', {
      data: invoiceBody({
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('1', '10.0000')],
      }),
    });
    const draft = (await res.json()) as { id: string };

    const otherVendedor = await createUser(api, 'VENDEDOR');
    const otherApi = await request.newContext({ baseURL });
    const login = await otherApi.post('/api/auth/login', {
      data: { email: otherVendedor.email, password: otherVendedor.password },
    });
    expect(login.ok()).toBeTruthy();

    const denied = await otherApi.delete(`/api/invoicing/documents/${draft.id}`, {
      data: { reason: 'No debería poder' },
    });
    expect(denied.status()).toBe(403);
  });
});
