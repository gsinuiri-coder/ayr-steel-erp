import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials } from '../helpers/api';
import { createInvoice, createInvoiceableCustomer, freeLine } from '../helpers/invoicing';

/**
 * HOTFIX-DESFASE — el detalle del comprobante no se cae si el API no coincide con el web.
 *
 * El 2026-09-16 la ventana F8-S7 publicó el web sin desplegar su API: el web nuevo leía
 * `issueDateChanges.length` de una respuesta que no traía el campo, y **toda** la pantalla del
 * comprobante caía con un `TypeError`. Lo que se protege:
 *
 * - Una respuesta **sin** los campos nuevos (`issueDateChanges`, `dispatchId`,
 *   `dispatchCode`) muestra el comprobante igual, sin error de página.
 * - Un 401 revalida la sesión: si cayó, `SessionProvider` lleva a `/login?next=…` (el re-login
 *   estándar); si sigue viva, se ve el error con «Reintentar». Nunca una pantalla muerta.
 * - Cualquier otro error se ve con su mensaje y un «Reintentar», sin crash.
 *
 * El API se simula con `page.route` sobre la respuesta real: el borrador existe de verdad y
 * solo se le quitan los campos. Crea un borrador: nunca contra producción (regla dura 9).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea un comprobante: nunca contra producción (D-126, regla dura 9).');

test.describe.configure({ timeout: 180_000 });

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

/** Solo el GET del detalle, no las acciones que cuelgan de la misma ruta. */
function detailUrl(id: string): (url: URL) => boolean {
  return (url) => url.pathname === `/api/invoicing/documents/${id}`;
}

test.describe('HOTFIX-DESFASE — detalle de comprobante defensivo', () => {
  test('una respuesta sin issueDateChanges/dispatchId/dispatchCode muestra el comprobante sin crash', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const draft = await createInvoice(api, {
      docType: 'FACTURA',
      customerId: customer.id,
      items: [freeLine('1', '10.0000', 'detalle defensivo')],
    });

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await loginAsAdmin(page);
    await page.route(detailUrl(draft.id), async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      delete body.issueDateChanges;
      delete body.dispatchId;
      delete body.dispatchCode;
      await route.fulfill({ response, json: body });
    });

    await page.goto(`/comprobantes/${draft.id}`);
    await expect(page.getByText(customer.name).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('No se pudo cargar el comprobante')).toHaveCount(0);
    expect(pageErrors, 'la pantalla no debe tirar errores de JavaScript').toEqual([]);
  });

  test('un 401 del detalle con la sesión caída lleva a /login con next', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const draft = await createInvoice(api, {
      docType: 'FACTURA',
      customerId: customer.id,
      items: [freeLine('1', '10.0000', 'detalle 401')],
    });

    await loginAsAdmin(page);
    await page.route(detailUrl(draft.id), (route) =>
      route.fulfill({ status: 401, json: { message: 'Unauthorized', statusCode: 401 } }),
    );
    await page.goto(`/comprobantes/${draft.id}`);
    const retry = page.getByRole('button', { name: 'Reintentar' });
    await expect(retry).toBeVisible({ timeout: 60_000 });

    // A partir de acá la sesión murió de verdad: sin cookies, el refresh también da 401 (y en
    // producción el API es quien las borra al fallar el refresh). Sin navegar —el middleware
    // redirigiría por su cuenta y no probaría nada de esta pantalla—, «Reintentar» vuelve a
    // pedir el detalle. `/auth/me` tiene `staleTime` de 60 s y no se revalida solo: lo
    // revalida el detalle al recibir el 401, y `SessionProvider` es quien redirige.
    await page.context().clearCookies();
    await retry.click();
    await expect(page).toHaveURL(
      new RegExp(`/login\\?next=${encodeURIComponent(`/comprobantes/${draft.id}`)}`),
      { timeout: 60_000 },
    );
  });

  test('un 401 del detalle con la sesión viva muestra el error y Reintentar, sin crash', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const draft = await createInvoice(api, {
      docType: 'FACTURA',
      customerId: customer.id,
      items: [freeLine('1', '10.0000', 'detalle 401 viva')],
    });

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await loginAsAdmin(page);
    await page.route(detailUrl(draft.id), (route) =>
      route.fulfill({ status: 401, json: { message: 'Unauthorized', statusCode: 401 } }),
    );
    await page.goto(`/comprobantes/${draft.id}`);
    await expect(page.getByText('No se pudo cargar el comprobante: Unauthorized')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/comprobantes/${draft.id}$`));
    expect(pageErrors).toEqual([]);
  });

  test('otro error muestra el mensaje y Reintentar, sin crash', async ({ page, baseURL }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const draft = await createInvoice(api, {
      docType: 'FACTURA',
      customerId: customer.id,
      items: [freeLine('1', '10.0000', 'detalle 500')],
    });

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await loginAsAdmin(page);
    let fail = true;
    await page.route(detailUrl(draft.id), async (route) => {
      if (fail) {
        await route.fulfill({ status: 500, json: { message: 'Falla simulada', statusCode: 500 } });
        return;
      }
      await route.continue();
    });

    await page.goto(`/comprobantes/${draft.id}`);
    await expect(page.getByText('No se pudo cargar el comprobante: Falla simulada')).toBeVisible({
      timeout: 60_000,
    });
    fail = false;
    await page.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.getByText(customer.name).first()).toBeVisible({ timeout: 30_000 });
    expect(pageErrors).toEqual([]);
  });
});
