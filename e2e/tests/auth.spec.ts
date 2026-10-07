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

/**
 * cc31: cerrar sesión vive en el menú de usuario del pie del menú lateral; en el primer ingreso
 * (sin menú) es el enlace «Salir e ingresar con otro usuario».
 */
async function logoutUi(page: import('@playwright/test').Page) {
  if (/\/cambiar-contrasena$/.test(page.url())) {
    await page.getByRole('button', { name: 'Salir e ingresar con otro usuario' }).click();
    return;
  }
  await page.getByRole('button', { name: /^Menú de / }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión' }).click();
}

test.describe('Autenticación (RF-01, RF-03)', () => {
  test('login correcto entra a la aplicación', async ({ page }) => {
    const { email, password } = adminCredentials();
    await login(page, email, password);
    // Puede caer en Inicio o en cambio de contraseña obligatorio; en ambos hay sesión.
    await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
    // S11/D-179: el correo vive en el `title` de la línea del usuario (menú de usuario, cc31);
    // en el primer ingreso, sin menú, se lee bajo «Elige tu contraseña».
    await expect(page.getByTitle(email).or(page.getByText(email, { exact: true }))).toBeVisible();
  });

  test('el ingreso muestra la contraseña con «Mostrar» y avisa la sesión vencida', async ({
    page,
  }) => {
    await page.goto('/login?next=%2Fdespachos%2Fnuevo&expired=1');
    await expect(page.getByRole('heading', { name: 'Ingresar' })).toBeVisible();
    await expect(
      page.getByRole('alert').filter({
        hasText: 'Tu sesión venció. Ingresa de nuevo y vuelves a Nuevo despacho.',
      }),
    ).toBeVisible();
    const password = page.getByLabel('Contraseña', { exact: true });
    await password.fill('secreta-123');
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Mostrar la contraseña' }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(
      page.getByText('¿Olvidaste tu contraseña? Pídele una temporal al administrador.'),
    ).toBeVisible();
  });

  test('login con contraseña incorrecta muestra error y no entra', async ({ page }) => {
    const { email } = adminCredentials();
    await login(page, email, 'contraseña-incorrecta-123');
    await expect(
      page.getByRole('alert').filter({
        hasText: 'El correo o la contraseña no coinciden. Revisa y vuelve a intentar.',
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: /^Menú de / })).toHaveCount(0);
  });

  test('cerrar sesión vuelve al login y protege las rutas', async ({ page }) => {
    const { email, password } = adminCredentials();
    await login(page, email, password);
    await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/);
    await logoutUi(page);
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
    await expect(
      page.getByRole('alert').filter({ hasText: 'Tu usuario está desactivado' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('cambiar el rol de un usuario invalida su sesión abierta', async ({ page, baseURL }) => {
    test.skip(skipWrites, 'Crea datos: en produccion solo con pnpm e2e:prod');
    const api = await adminApi(baseURL!);
    const user = await createUser(api, 'VENDEDOR');

    await login(page, user.email, user.password);
    // Primer ingreso: la pantalla de «Elige tu contraseña», ya con sesión.
    await expect(page.getByRole('heading', { name: 'Elige tu contraseña' })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: 'Elige tu contraseña' })).toBeVisible();

    // Intentar ir a otra ruta lo devuelve al cambio de contraseña.
    await page.goto('/');
    await expect(page).toHaveURL(/\/cambiar-contrasena$/);

    await page.getByLabel('Contraseña temporal').fill(user.password);
    await page.getByLabel('Contraseña nueva', { exact: true }).fill('NuevaClave2026!');
    await page.getByLabel('Repite la contraseña nueva').fill('NuevaClave2026!');
    await page.getByRole('button', { name: 'Guardar y entrar' }).click();

    await expect(page).toHaveURL(/\/$/);
    // S10/M2: "Inicio" pasa a llamarse "Panel".
    await expect(page.getByRole('heading', { name: 'Panel' })).toBeVisible();
    // Un supervisor no ve el módulo de usuarios.
    await expect(page.getByRole('link', { name: 'Usuarios' })).toHaveCount(0);
  });
});
