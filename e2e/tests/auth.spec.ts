import { expect, test } from '@playwright/test';
import { adminApi, adminCredentials, createUser } from '../helpers/api';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Contra producción los escenarios que crean datos solo corren si se piden de forma
 * explícita (`pnpm e2e:prod`), que además crea el administrador efímero y limpia al final.
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

async function login(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
}

test.describe('Autenticación (RF-01, RF-03)', () => {
  test('login correcto entra a la aplicación', async ({ page }) => {
    const { email, password } = adminCredentials();
    await login(page, email, password);
    // Puede caer en Inicio o en cambio de contraseña obligatorio; en ambos hay sesión.
    await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/);
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
  });

  test('login con contraseña incorrecta muestra error y no entra', async ({ page }) => {
    const { email } = adminCredentials();
    await login(page, email, 'contraseña-incorrecta-123');
    await expect(
      page.getByRole('alert').filter({ hasText: 'Credenciales inválidas' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toHaveCount(0);
  });

  test('cerrar sesión vuelve al login y protege las rutas', async ({ page }) => {
    const { email, password } = adminCredentials();
    await login(page, email, password);
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });

  test('usuario desactivado no puede iniciar sesión', async ({ page, baseURL }) => {
    test.skip(skipWrites, 'Crea datos: en produccion solo con pnpm e2e:prod');
    const api = await adminApi(baseURL!);
    const user = await createUser(api, 'VENDEDOR');
    const res = await api.delete(`/api/users/${user.id}`);
    expect(res.ok()).toBeTruthy();

    await login(page, user.email, user.password);
    await expect(page.getByRole('alert').filter({ hasText: 'Usuario desactivado' })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('cambiar el rol de un usuario invalida su sesión abierta', async ({ page, baseURL }) => {
    test.skip(skipWrites, 'Crea datos: en produccion solo con pnpm e2e:prod');
    const api = await adminApi(baseURL!);
    const user = await createUser(api, 'VENDEDOR');

    await login(page, user.email, user.password);
    await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
    const meBefore = await page.request.get('/api/auth/me');
    expect(meBefore.status()).toBe(200);

    const patch = await api.patch(`/api/users/${user.id}`, { data: { role: 'SUPERVISOR_PLANTA' } });
    expect(patch.ok()).toBeTruthy();

    // El access token y el refresh token quedaron revocados.
    const meAfter = await page.request.get('/api/auth/me');
    expect(meAfter.status()).toBe(401);
    const refresh = await page.request.post('/api/auth/refresh');
    expect(refresh.status()).toBe(401);

    await page.reload();
    await expect(page).toHaveURL(/\/login/);
  });

  test('un usuario nuevo debe cambiar su contraseña al primer ingreso', async ({
    page,
    baseURL,
  }) => {
    test.skip(skipWrites, 'Crea datos: en produccion solo con pnpm e2e:prod');
    const api = await adminApi(baseURL!);
    const user = await createUser(api, 'SUPERVISOR_PLANTA');

    await login(page, user.email, user.password);
    await expect(page).toHaveURL(/\/cambiar-contrasena$/);
    await expect(page.getByRole('heading', { name: 'Cambiar contraseña' })).toBeVisible();

    // Intentar ir a otra ruta lo devuelve al cambio de contraseña.
    await page.goto('/');
    await expect(page).toHaveURL(/\/cambiar-contrasena$/);

    await page.getByLabel('Contraseña actual').fill(user.password);
    await page.getByLabel('Nueva contraseña', { exact: true }).fill('NuevaClave2026!');
    await page.getByLabel('Confirmar nueva contraseña').fill('NuevaClave2026!');
    await page.getByRole('button', { name: 'Guardar contraseña' }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: 'Inicio' })).toBeVisible();
    // Un supervisor no ve el módulo de usuarios.
    await expect(page.getByRole('link', { name: 'Usuarios' })).toHaveCount(0);
  });
});
