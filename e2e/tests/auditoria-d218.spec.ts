import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createUser } from '../helpers/api';
import { getExpectingError } from '../helpers/production';
import { loginAndSetPassword } from '../helpers/ui';

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
  test('el alta de un usuario deja una fila en /auditoria filtrando por tipo de entidad e id', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const created = await createUser(api, 'VENDEDOR');

    await loginAsAdmin(page);
    await page.goto('/auditoria');
    await expect(page.getByRole('heading', { name: 'Auditoría' })).toBeVisible();

    await page.getByRole('combobox', { name: 'Tipo de entidad' }).click();
    await page.getByRole('option', { name: 'Usuarios', exact: true }).click();
    await page.getByLabel('ID de entidad').fill(created.id);

    // No depende del texto de la acción (podría reformularse): el id exacto y el tipo de
    // entidad alcanzan para identificar la fila sin ambigüedad.
    const row = page.getByRole('row').filter({ hasText: created.id });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('Usuarios');
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
