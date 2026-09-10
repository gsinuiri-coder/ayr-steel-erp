import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import { DISPATCH_LINE, purgeInvoicingTrail, type InvoicingTrail } from '../helpers/invoicing';
import { createCustomer, createDirectOrder, buyCoilForSale } from '../helpers/sales';
import {
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrder,
  reservationsOf,
  roofingOrder,
  setupRoofingScenario,
} from '../helpers/roofing';

/**
 * **D-172 por pantalla**: la tarjeta "Órdenes de producción" del detalle de una bobina
 * (`/bobinas/[id]`) y el link del nombre de un cliente hacia `/clientes?search=<docNumber>`.
 *
 * Lo que `bobina-consumos-pdf-d172.spec.ts` ya fija por API es que el dato existe y trae los
 * códigos correctos. Lo que falta, y es lo único que hay acá, es que la pantalla lo pinta y
 * que sus links navegan a donde dicen:
 *
 * - la tarjeta nueva del detalle de la bobina muestra la fila de la OP que la montó, con el
 *   link a `/produccion/:id`;
 * - el nombre del cliente en `/pedidos` linkea a `/clientes?search=<RUC>` y esa pantalla
 *   arranca con el buscador ya cargado, filtrando a ese cliente.
 *
 * Monta una bobina en una OP y crea un pedido directo: contra producción solo con
 * `E2E_ALLOW_WRITES=1` (D-024, regla dura 9).
 */
const isProduction = !!process.env.E2E_BASE_URL;
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

test.describe.configure({ timeout: 240_000 });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  const logged = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Ingresar' }).click();
  expect((await logged).ok(), 'El login del admin debía responder 2xx').toBe(true);
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

test.describe('D-172 — la pantalla de la bobina y el link de cliente', () => {
  test.skip(skipWrites, 'Escribe kardex: contra producción solo con E2E_ALLOW_WRITES=1 (D-024)');

  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('la tarjeta "Órdenes de producción" muestra la OP que montó la bobina y su link navega', async ({
    page,
  }) => {
    const scenario = await setupRoofingScenario(api, { weightKg: '500' });
    const customer = await createCustomer(api);
    const trail: Parameters<typeof purgeRoofingTrail>[1] = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };

    try {
      const rows = pieces([4, 2]);
      const { quotation, order } = await quoteAndOrder(api, {
        customerId: customer.id,
        productId: scenario.product.id,
        rows,
        unitPricePen: '30',
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];

      const reservations = await reservationsOf(api, order.id);
      const created = await roofingOrder(api, reservations[0]!.id);
      trail.productionOrderIds = [created.id];
      await mountCoil(api, created.id, { coilId: scenario.coil.id });

      await loginAsAdmin(page);
      await page.goto(`/bobinas/${scenario.coil.id}`);
      await expect(page.getByRole('heading', { name: scenario.coil.code })).toBeVisible({
        timeout: 60_000,
      });

      // `CardTitle` es un `<div>`, no un heading (`card.tsx`): se busca por el texto visible
      // y se sube al contenedor de la tarjeta, mismo patrón que `cierre-bobina-ui-d164`. Se
      // busca dentro de `main` y no en toda la página porque el ítem de navegación del
      // sidebar tiene el mismo texto ("Órdenes de producción" también es un link del menú).
      const card = page
        .locator('main')
        .getByText('Órdenes de producción', { exact: true })
        .locator('../..');
      const opLink = card.getByRole('link', { name: created.code });
      await expect(opLink).toBeVisible();
      // El pedido y el cliente detrás de la OP viajan en la misma fila.
      await expect(card.getByRole('link', { name: order.code })).toBeVisible();
      await expect(card).toContainText(customer.name);

      await opLink.click();
      await expect(page).toHaveURL(new RegExp(`/produccion/${created.id}$`));
      await expect(page.getByRole('heading', { name: created.code })).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await purgeRoofingTrail(api, trail);
    }
  });

  test('el nombre del cliente en /pedidos navega a /clientes?search=<RUC> ya filtrado', async ({
    page,
  }) => {
    const stock = await buyCoilForSale(api, {
      lineCode: DISPATCH_LINE,
      weightKg: '200',
      coilStatus: 'OPEN',
    });
    const customer = await createCustomer(api);
    const trail: InvoicingTrail = {
      dispatchIds: [],
      orderIds: [],
      coilIds: [stock.coil.id],
      purchaseId: stock.purchaseId,
      supplierId: stock.supplier.id,
      finish: stock.finish,
    };

    try {
      const order = await createDirectOrder(api, {
        customerId: customer.id,
        businessLine: DISPATCH_LINE,
        items: [{ saleCoilId: stock.coil.id, qty: '150.000', unitPricePen: '8.0000' }],
      });
      trail.orderIds = [order.id];

      await loginAsAdmin(page);
      await page.goto('/pedidos');
      await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible({
        timeout: 60_000,
      });
      // El buscador de pedidos es contra el API: se filtra por el código del pedido recién
      // creado para no depender de en qué página de la lista general cayó.
      await page.getByPlaceholder('Buscar por código, cliente o documento…').fill(order.code);
      const row = page.getByRole('row').filter({ hasText: order.code });
      await expect(row).toBeVisible();

      await row.getByRole('link', { name: customer.name }).click();
      await expect(page).toHaveURL(
        new RegExp(`/clientes\\?search=${encodeURIComponent(customer.docNumber)}$`),
      );
      await expect(page.getByRole('heading', { name: 'Clientes' })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByRole('row').filter({ hasText: customer.docNumber })).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: customer.name })).toBeVisible();
    } finally {
      await purgeInvoicingTrail(api, trail);
    }
  });
});
