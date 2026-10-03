import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, getJson, postJson } from '../helpers/api';
import {
  balanceOf,
  live,
  movementsOf,
  postExpectingError,
  today,
  uniqueDocumentNumber,
} from '../helpers/production';
import { reservationsOf } from '../helpers/roofing';
import { createCustomer, createDirectOrder, createSellableProduct } from '../helpers/sales';

/**
 * **D-372, sesión 2, segunda parte (cc15b).**
 *
 * - Punto 3: con una reserva activa, el precio y la cantidad se corrigen con `replaceEntry`: la
 *   reserva se comprueba sobre el saldo **final**. Una cantidad que no la cubre se bloquea.
 * - Concurrencia: una corrección de cantidad y una reserva nueva a la vez nunca dejan el saldo
 *   por debajo de lo reservado.
 * - Punto 4: con otra compra posterior del mismo producto (sin salidas), la línea se corrige.
 *
 * Escribe compras y pedidos: nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras y pedidos: nunca contra producción (D-126).');
test.describe.configure({ timeout: 180_000 });

const LINE = 'drywall';

interface PurchaseDto {
  id: string;
  items: { id: string; qty: string; unitPrice: string }[];
}
interface PlanDto {
  changes: { field: string; path: string; blockedReason: string | null }[];
  warnings?: string[];
  executable: boolean;
}

async function buyProduct(
  api: APIRequestContext,
  supplierId: string,
  productId: string,
  qty: string,
  unitPrice: string,
): Promise<PurchaseDto> {
  const purchase = await postJson<{ id: string }>(api, '/api/purchases', {
    supplierId,
    businessLine: LINE,
    type: 'FINISHED_GOOD',
    docType: 'FACTURA',
    series: 'F001',
    number: uniqueDocumentNumber(),
    issueDate: today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: [{ productId, description: 'Producto E2E cc15b', qty, unit: 'NIU', unitPrice }],
  });
  await postJson(api, `/api/purchases/${purchase.id}/receive`);
  return getJson<PurchaseDto>(api, `/api/purchases/${purchase.id}`);
}

test.describe('D-372 sesión 2 (cc15b)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });
  test.afterAll(async () => {
    await api.dispose();
  });

  test('punto 3: con una reserva activa, el precio y una cantidad que la cubre pasan; una que no, se bloquea', async () => {
    const supplier = await createSupplier(api, { name: 'E2E Proveedor cc15b reserva' });
    const product = await createSellableProduct(api, { lineCode: LINE, listPricePen: '50.0000' });
    const purchase = await buyProduct(api, supplier.id, product.id, '10', '20');
    const customer = await createCustomer(api);
    const order = await createDirectOrder(api, {
      customerId: customer.id,
      businessLine: LINE,
      items: [{ productId: product.id, qty: '5', unitPricePen: '50.0000' }],
    });
    expect((await reservationsOf(api, order.id)).some((r) => r.status === 'ACTIVE')).toBe(true);
    const item = purchase.items[0]!;

    const price = await postJson<PlanDto>(
      api,
      `/api/purchases/${purchase.id}/received-edit/preview`,
      { items: [{ itemId: item.id, unitPrice: '22' }] },
    );
    expect(price.changes[0]?.path).toBe('REVERSE_REENTRY');
    const short = await postJson<PlanDto>(
      api,
      `/api/purchases/${purchase.id}/received-edit/preview`,
      { items: [{ itemId: item.id, qty: '4' }] },
    );
    expect(short.changes[0]?.blockedReason).toContain('quedarían 4.000 y hay 5.000 reservados');
    const rejected = await postExpectingError(api, `/api/purchases/${purchase.id}/received-edit`, {
      items: [{ itemId: item.id, qty: '4' }],
      reason: 'No cubre la reserva (E2E cc15b)',
    });
    expect(rejected.status).toBe(400);

    await postJson(api, `/api/purchases/${purchase.id}/received-edit`, {
      items: [{ itemId: item.id, unitPrice: '22', qty: '6' }],
      reason: 'Precio y cantidad con reserva (E2E cc15b)',
    });
    expect(await balanceOf(api, 'PRODUCT', product.id)).toMatchObject({
      qty: '6.000',
      avgCost: '22.0000',
    });
    // La reserva sigue activa y el kardex tiene un solo ingreso vivo.
    expect((await reservationsOf(api, order.id)).some((r) => r.status === 'ACTIVE')).toBe(true);
    expect(live(await movementsOf(api, 'PRODUCT', product.id))).toHaveLength(1);
  });

  test('concurrencia: una corrección de cantidad y una reserva nueva a la vez no dejan el saldo bajo lo reservado', async () => {
    const supplier = await createSupplier(api, { name: 'E2E Proveedor cc15b carrera' });
    const product = await createSellableProduct(api, { lineCode: LINE, listPricePen: '50.0000' });
    const purchase = await buyProduct(api, supplier.id, product.id, '10', '20');
    const customer = await createCustomer(api);
    const item = purchase.items[0]!;

    const [edit, order] = await Promise.allSettled([
      postJson(api, `/api/purchases/${purchase.id}/received-edit`, {
        items: [{ itemId: item.id, qty: '4' }],
        reason: 'Carrera con una reserva (E2E cc15b)',
      }),
      createDirectOrder(api, {
        customerId: customer.id,
        businessLine: LINE,
        items: [{ productId: product.id, qty: '8', unitPricePen: '50.0000' }],
      }),
    ]);
    // Al menos una de las dos se hizo, y el estado final respeta saldo ≥ reservado (D-066).
    expect([edit.status, order.status]).toContain('fulfilled');
    const balance = await balanceOf(api, 'PRODUCT', product.id);
    const reserved =
      order.status === 'fulfilled'
        ? (await reservationsOf(api, order.value.id))
            .filter((r) => r.status === 'ACTIVE' && r.itemType === 'PRODUCT')
            .reduce((sum, r) => sum + Number(r.qty), 0)
        : 0;
    expect(Number(balance.qty)).toBeGreaterThanOrEqual(reserved);
    // Si la edición ganó, quedaron 4; si la reserva ganó primero, la edición se rechazó.
    if (edit.status === 'fulfilled') expect(balance.qty).toBe('4.000');
    else expect(balance.qty).toBe('10.000');
  });

  test('punto 4: con otra compra posterior del mismo producto, la línea se corrige y el promedio cuadra', async () => {
    const supplier = await createSupplier(api, { name: 'E2E Proveedor cc15b posterior' });
    const product = await createSellableProduct(api, { lineCode: LINE, listPricePen: '50.0000' });
    const first = await buyProduct(api, supplier.id, product.id, '10', '20');
    await buyProduct(api, supplier.id, product.id, '4', '20');
    const item = first.items[0]!;

    const plan = await postJson<PlanDto>(api, `/api/purchases/${first.id}/received-edit/preview`, {
      items: [{ itemId: item.id, unitPrice: '27' }],
    });
    expect(plan.changes[0]?.path).toBe('REVERSE_REENTRY');
    // Hay existencias de otra compra: la vista previa avisa del redondeo al deshacer.
    expect(plan.warnings?.join(' ')).toContain('±0,0001');

    await postJson(api, `/api/purchases/${first.id}/received-edit`, {
      items: [{ itemId: item.id, unitPrice: '27' }],
      reason: 'Precio con compra posterior (E2E cc15b)',
    });
    // 10 a 27 + 4 a 20 = 350 / 14 = 25.
    expect(await balanceOf(api, 'PRODUCT', product.id)).toMatchObject({
      qty: '14.000',
      avgCost: '25.0000',
    });
  });
});
