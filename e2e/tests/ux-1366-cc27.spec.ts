import { expect, test, type Page } from '@playwright/test';
import { adminCredentials } from '../helpers/api';
import { openSidebarGroup } from '../helpers/ui';

/**
 * cc27 / M3 (D-454, D-455, D-456) — los formularios largos a 1366 × 768.
 *
 * - La página no scrollea en horizontal y la acción principal se ve sin bajar: la barra de
 *   acciones queda fija abajo (UX26-06/07) aunque el formulario mida más que la ventana.
 * - Salir de un formulario con cambios avisa —enlace interno, atrás y recargar— y sin cambios
 *   no (UX26-13). Quedarse conserva lo escrito.
 *
 * Solo lectura: abre formularios y no guarda nada, así que no escribe en la base.
 */

test.use({ viewport: { width: 1366, height: 768 } });

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Cada formulario tocado, con su título y su acción principal. */
const FORMS: { path: string; heading: string; action: string }[] = [
  { path: '/cotizaciones/nueva', heading: 'Nueva cotización', action: 'Crear cotización' },
  { path: '/pedidos/nuevo', heading: 'Nuevo pedido', action: 'Crear pedido' },
  { path: '/compras/nueva', heading: 'Nueva compra', action: 'Registrar compra' },
  { path: '/despachos/nuevo', heading: 'Nuevo despacho', action: 'Despachar' },
];

test.describe('cc27 — formularios largos a 1366 × 768', () => {
  for (const form of FORMS) {
    test(`${form.path}: sin scroll horizontal y con «${form.action}» a la vista`, async ({
      page,
    }) => {
      await loginAsAdmin(page);
      await page.goto(form.path);
      await expect(page.getByRole('heading', { name: form.heading, level: 1 })).toBeVisible({
        timeout: 60_000,
      });
      const action = page.getByRole('button', { name: form.action, exact: true });
      await expect(action).toBeInViewport();
      await expect.poll(() => horizontalOverflow(page)).toBe(0);
    });
  }

  test('la cotización con varias líneas sigue mostrando «Crear cotización» sin bajar', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/cotizaciones/nueva');
    const add = page.getByRole('button', { name: 'Agregar línea', exact: true });
    await expect(add).toBeVisible({ timeout: 60_000 });
    for (let i = 0; i < 4; i += 1) await add.click();
    // El formulario ya es más alto que la ventana: sin la barra fija, el botón quedaba abajo.
    expect(
      await page.evaluate(() => document.querySelector('main')?.scrollHeight ?? 0),
    ).toBeGreaterThan(768);
    await expect(
      page.getByRole('button', { name: 'Crear cotización', exact: true }),
    ).toBeInViewport();
    await expect.poll(() => horizontalOverflow(page)).toBe(0);
  });
});

test.describe('cc27 — cambios sin guardar (UX26-13)', () => {
  test('sin cambios, salir no pregunta', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/cotizaciones/nueva');
    await expect(page.getByLabel('Observaciones')).toBeVisible({ timeout: 60_000 });
    let asked = false;
    page.on('dialog', (dialog) => {
      asked = true;
      void dialog.dismiss();
    });
    await openSidebarGroup(page, 'Comercial');
    await page.getByRole('link', { name: 'Pedidos', exact: true }).click();
    await expect(page).toHaveURL(/\/pedidos$/, { timeout: 30_000 });
    expect(asked).toBe(false);
  });

  test('escribir y borrar deja el formulario limpio: «atrás» sale con una sola pulsación (A-1)', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/pedidos');
    await expect(page.getByRole('heading', { name: 'Pedidos', level: 1 })).toBeVisible({
      timeout: 60_000,
    });
    await page.goto('/cotizaciones/nueva');
    const notes = page.getByLabel('Observaciones');
    await expect(notes).toBeVisible({ timeout: 60_000 });
    let asked = false;
    page.on('dialog', (dialog) => {
      asked = true;
      void dialog.dismiss();
    });
    await notes.fill('algo');
    await notes.fill('');
    await page.goBack();
    await expect(page).toHaveURL(/\/pedidos$/, { timeout: 30_000 });
    expect(asked).toBe(false);
  });

  test('con cambios: el enlace, atrás y recargar preguntan; quedarse conserva lo escrito', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/cotizaciones/nueva');
    const notes = page.getByLabel('Observaciones');
    await expect(notes).toBeVisible({ timeout: 60_000 });
    await notes.fill('Entregar en obra, coordinar con el residente');

    // 1. Un enlace del menú: se pregunta y, al quedarse, no se navega.
    const messages: string[] = [];
    page.once('dialog', (dialog) => {
      messages.push(dialog.message());
      void dialog.dismiss();
    });
    await openSidebarGroup(page, 'Comercial');
    await page.getByRole('link', { name: 'Pedidos', exact: true }).click();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toContain('cambios sin guardar');
    await expect(page).toHaveURL(/\/cotizaciones\/nueva$/);
    await expect(notes).toHaveValue('Entregar en obra, coordinar con el residente');

    // 2. Atrás del navegador: se pregunta y, al quedarse, sigue el formulario con lo escrito.
    page.once('dialog', (dialog) => {
      messages.push(dialog.message());
      void dialog.dismiss();
    });
    await page.goBack();
    await expect.poll(() => messages.length).toBe(2);
    await expect(page).toHaveURL(/\/cotizaciones\/nueva$/);
    await expect(notes).toHaveValue('Entregar en obra, coordinar con el residente');

    // 3. Recargar: el aviso es el del navegador (`beforeunload`).
    let beforeUnload = false;
    page.once('dialog', (dialog) => {
      beforeUnload = dialog.type() === 'beforeunload';
      void dialog.dismiss();
    });
    await page.reload({ timeout: 5_000 }).catch(() => undefined);
    await expect.poll(() => beforeUnload).toBe(true);
    await expect(notes).toHaveValue('Entregar en obra, coordinar con el residente');

    // 4. Aceptar sale de verdad.
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.getByRole('link', { name: 'Pedidos', exact: true }).click();
    await expect(page).toHaveURL(/\/pedidos$/, { timeout: 30_000 });
  });
});
