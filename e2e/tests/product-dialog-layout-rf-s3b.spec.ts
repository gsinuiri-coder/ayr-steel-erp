import { expect, test, type Page } from '@playwright/test';
import { adminCredentials } from '../helpers/api';

/**
 * RF-S3b/M5: el alta/edición de producto es un diálogo de escritorio y tiene variantes
 * reales por línea. La más larga (Coberturas Aluzinc) debe desplazar solo el cuerpo del
 * formulario: título y acciones permanecen visibles, y ninguna variante crea scroll
 * horizontal ni a 1366×768 ni a 1920×1080.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'La verificación de layout usa el catálogo sembrado local/CI.');
test.describe.configure({ timeout: 120_000 });

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
] as const;

const LINES = [
  'Drywall',
  'Coberturas Aluzinc',
  'Coberturas (UPVC)',
  'Reventa',
  'Servicios',
] as const;

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

test('ProductDialog cabe en las cinco líneas y las dos resoluciones de escritorio', async ({
  page,
}) => {
  await loginAsAdmin(page);
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/catalogo');
    await expect(page.getByRole('heading', { name: 'Catálogo' })).toBeVisible();

    for (const line of LINES) {
      await page.getByRole('tab', { name: line, exact: true }).click();
      await page.getByRole('button', { name: 'Nuevo producto' }).click();
      const dialog = page.getByRole('dialog', { name: 'Nuevo producto' });
      const create = dialog.getByRole('button', { name: 'Crear producto' });
      await expect(dialog).toBeVisible();
      await expect(create).toBeVisible();

      const measured = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          dialogWidth: Math.round(rect.width),
          dialogHeight: Math.round(rect.height),
          horizontalOverflow: element.scrollWidth - element.clientWidth,
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
        };
      });
      console.info(
        `[ProductDialog] ${String(viewport.width)}x${String(viewport.height)} | ${line} | ${JSON.stringify(measured)}`,
      );
      // El fondo puede contener datos creados por otros specs; el overflow de página se cubre
      // de forma aislada en layout-scroll-horizontal-d179. Acá el contrato es el del diálogo.
      expect(measured.horizontalOverflow, `${line}: overflow interno`).toBeLessThanOrEqual(0);
      expect(measured.left).toBeGreaterThanOrEqual(0);
      expect(measured.top).toBeGreaterThanOrEqual(0);
      expect(measured.right).toBeLessThanOrEqual(viewport.width);
      expect(measured.bottom).toBeLessThanOrEqual(viewport.height);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  }
});
