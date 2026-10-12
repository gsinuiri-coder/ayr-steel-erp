import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createUser } from '../helpers/api';
import { createInvoiceableCustomer, freeLine, invoiceBody } from '../helpers/invoicing';
import { getExpectingError } from '../helpers/production';
import { createSellableProduct } from '../helpers/sales';
import { loginAndSetPassword, moreOption, openFilters } from '../helpers/ui';

/**
 * RF-S2/D-218 — visor unificado de auditoría (`/auditoria`, `GET /audit`), admin-only.
 *
 * Dos escenarios, del brief de cierre de la sesión:
 * 1. Una acción sensible barata y determinística (alta de usuario, RF-04 vía
 *    `POST /api/users` — ya dispara `users.create` en `audit_log`, ver
 *    `apps/api/src/users/users.service.ts`) aparece en el visor filtrando por tipo de
 *    entidad y el id exacto de lo que se tocó, sin depender del texto de detalle.
 * 2. Un no-admin (VENDEDOR) no ve el ítem de menú, `/auditoria` corta con el mensaje de
 *    `RoleGate` en vez de reventar, y `GET /api/audit` responde 403 del lado del server
 *    (el guard real; la UI no alcanza).
 *
 * Crea un usuario desechable por escenario: nunca contra producción (D-126, regla dura 9).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea usuarios: nunca contra producción (D-126).');

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test.describe('Auditoría (RF-95, D-218) — un administrador ve una acción sensible', () => {
  test('el alta de un usuario deja una fila con su nombre (cc48): buscar, «Filtros» y la URL', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const name = `Auditoria cc48 ${String(Date.now())}`;
    const created = await createUser(api, 'VENDEDOR', { name });

    await loginAsAdmin(page);
    await page.goto('/auditoria');
    await expect(page.getByRole('heading', { name: 'Auditoría' })).toBeVisible();

    // cc47 (D-615): los filtros se eligen en el modal «Filtros» y se aplican juntos; cc48
    // (D-634): quedan en la URL.
    const modal = await openFilters(page);
    await modal.getByRole('combobox', { name: 'Tipo de entidad' }).click();
    await page.getByRole('option', { name: 'Usuarios', exact: true }).click();
    await modal.getByRole('button', { name: 'Aplicar' }).click();
    await expect(page.getByRole('button', { name: 'Filtros, 1 activo' })).toBeVisible();
    await expect(page).toHaveURL(/entityType=users/);

    // D-634: buscar primero, por el código legible (el nombre del usuario) — resuelto a su id.
    await page.getByRole('searchbox', { name: 'Buscar en la auditoría' }).fill(name);
    await expect(page).toHaveURL(/search=/);
    // D-633: la fila muestra el nombre, no el UUID; el id sigue a mano en «Copiar id».
    const row = page.getByTestId('fila-auditoria').filter({ hasText: name });
    await expect(row.first()).toBeVisible({ timeout: 15_000 });
    await expect(row.first()).toContainText('Usuarios');
    await expect(row.first()).not.toContainText(created.id);
    await expect(row.first().getByRole('button', { name: 'Copiar id' })).toHaveAttribute(
      'title',
      created.id,
    );

    // Refrescar y volver atrás dan la misma lista.
    await page.reload();
    await expect(page.getByRole('searchbox', { name: 'Buscar en la auditoría' })).toHaveValue(name);
    await expect(row.first()).toBeVisible({ timeout: 15_000 });

    // D-635: el «Historial» de una entidad entra por la URL, filtrado y con su aviso.
    await page.goto(`/auditoria?entityType=users&entityId=${created.id}`);
    await expect(page.getByTestId('filtro-documento')).toBeVisible();
    await expect(page.getByTestId('fila-auditoria').filter({ hasText: name }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Últimos 12 meses')).toBeVisible();

    // El Excel en «Más opciones», con lo mismo que la lista.
    await expect(await moreOption(page, 'Descargar Excel')).toHaveAttribute(
      'href',
      `/api/audit/xlsx?entityType=users&entityId=${created.id}`,
    );
    await page.keyboard.press('Escape');

    // Con más de 31 días, el buscar avisa que solo busca por código (regla del dueño).
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    await page.goto(`/auditoria?search=demo&from=${sixtyDaysAgo}`);
    await expect(page.getByTestId('aviso-buscar')).toContainText('solo por código');
  });
});

/**
 * D-225/RF-S2-INTEGRA: lo que S1 (precios de lista, D-217) y el hotfix de borradores (D-223)
 * escriben tiene que verse en el visor. Se entra por la URL que arma el link "Historial"
 * (`?entityType=&entityId=`), igual que desde el detalle.
 */
test.describe('Auditoría (D-225) — precio de lista y borrador descartado en el visor', () => {
  test('una edición del precio de lista deja la edición del producto y el cambio de precio', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const product = await createSellableProduct(api, {
      lineCode: 'roofing',
      listPricePen: '10.0000',
    });
    const patched = await api.patch(`/api/catalog/${product.id}`, {
      data: { listPricePen: '12.5000' },
    });
    expect(patched.ok(), await patched.text()).toBeTruthy();

    await loginAsAdmin(page);
    await page.goto(`/auditoria?entityType=products&entityId=${product.id}`);
    await expect(page.getByRole('heading', { name: 'Auditoría' })).toBeVisible();

    // El alta con precio ya deja su propio cambio (sin precio → 10): se busca el de la edición.
    // El visor muestra el precio de lista con IGV, como el catálogo (D-217/ajustes UAT):
    // 10.0000 y 12.5000 (sin IGV, lo que guarda `listPricePen`) se ven como 11.80 y 14.75.
    const priceRows = page.getByRole('row').filter({ hasText: 'Cambio de precio de lista' });
    await expect(priceRows.filter({ hasText: '14.75' })).toBeVisible({ timeout: 15_000 });
    await expect(
      priceRows.filter({ hasText: '11.80' }).filter({ hasNotText: '14.75' }),
    ).toBeVisible();
    await expect(
      page.getByRole('row').filter({ hasText: 'Edición de producto' }).filter({ hasText: '14.75' }),
    ).toBeVisible();
  });

  test('descartar un borrador deja la creación y el descarte, con el motivo a la vista', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const customer = await createInvoiceableCustomer(api);
    const created = await api.post('/api/invoicing/documents', {
      data: invoiceBody({
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('1', '10.0000')],
      }),
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const draft = (await created.json()) as { id: string };
    const reason = `E2E D-225 borrador de más ${draft.id.slice(0, 8)}`;
    const discarded = await api.delete(`/api/invoicing/documents/${draft.id}`, {
      data: { reason },
    });
    expect(discarded.status()).toBe(204);

    await loginAsAdmin(page);
    await page.goto(`/auditoria?entityType=fiscal_documents&entityId=${draft.id}`);
    await expect(page.getByRole('heading', { name: 'Auditoría' })).toBeVisible();

    const discardRow = page
      .getByRole('row')
      .filter({ hasText: 'Borrador de comprobante descartado' });
    await expect(discardRow).toBeVisible({ timeout: 15_000 });
    await expect(discardRow).toContainText(reason);
    await expect(page.getByRole('row').filter({ hasText: 'Comprobante creado' })).toBeVisible();
  });
});

test.describe('Auditoría (RF-95, D-218) — un no-admin no entra', () => {
  test('un vendedor no ve "Auditoría" en el menú, /auditoria corta con el mensaje de RoleGate y GET /api/audit responde 403', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const vendedor = await createUser(api, 'VENDEDOR');

    await loginAndSetPassword(page, vendedor, 'ClaveVendedorE2E-2026');

    // (a) el ítem de menú no aparece para un rol que no es ADMINISTRADOR.
    await expect(page.getByRole('link', { name: 'Auditoría' })).toHaveCount(0);

    // (b) navegar directo a la URL corta con el mensaje de RoleGate, no revienta.
    await page.goto('/auditoria');
    await expect(page.getByText('No tienes permiso para ver esta sección.')).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);

    // (c) el guard del server es el que manda: `page.request` reutiliza las cookies de la
    // sesión ya logueada como vendedor, así que esto es el mismo 403 que vería el navegador.
    const denied = await getExpectingError(page.request, '/api/audit');
    expect(denied.status, 'GET /api/audit').toBe(403);
  });
});
