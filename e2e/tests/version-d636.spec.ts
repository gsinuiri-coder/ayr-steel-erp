import { expect, test } from '@playwright/test';
import { adminCredentials } from '../helpers/api';

/**
 * D-636: `/version` dice con qué commit se compiló la web, sin sesión y con sesión, sin caché y
 * sin nada más que el sha y la fecha del build. `/api/health` dice el de la API. En local y en la
 * CI no hay `VERCEL_GIT_COMMIT_SHA` ni `GIT_SHA`: los dos dicen «dev».
 *
 * Solo lectura (salvo el login): puede correr contra cualquier entorno.
 */
const isProduction = !!process.env.E2E_BASE_URL;

test.describe('D-636 — commit publicado', () => {
  test('/version responde sin sesión, sin caché y solo con sha y fecha', async ({ request }) => {
    const res = await request.get('/version', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['builtAt', 'sha']);
    expect(typeof body.sha).toBe('string');
    if (!isProduction) expect(body.sha).toBe('dev');
    else expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('/version con sesión no redirige al inicio', async ({ page }) => {
    const { email, password } = adminCredentials();
    await page.goto('/login');
    await page.getByLabel('Correo electrónico').fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });

    const res = await page.request.get('/version', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { sha: string }).sha).toBeTruthy();
  });

  test('/api/health trae el sha de la API', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status: string; sha: string };
    expect(body.status).toBe('ok');
    if (!isProduction) expect(body.sha).toBe('dev');
    else expect(body.sha).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
