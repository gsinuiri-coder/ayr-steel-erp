import { expect, test, type Page } from '@playwright/test';
import { adminCredentials } from '../helpers/api';

/**
 * D-293 (correcciones 03, punto 10): el modelo de formularios. Se **mide en el navegador**, no
 * a ojo (lección de S11: una captura escalada no es una medida):
 *
 * - ninguna celda de una grilla se pisa con otra;
 * - el control de cada celda arranca a la **misma distancia** del borde de su celda (el rótulo
 *   mide siempre lo mismo), así que el texto de ayuda de un vecino no lo mueve;
 * - no hay scroll horizontal ni en la página ni en el diálogo.
 *
 * A 1366 y a 1920 px, los dos anchos de escritorio del sistema (D-179). Solo lee pantallas:
 * abre los formularios y los cierra sin guardar.
 */
test.describe.configure({ timeout: 240_000 });

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
] as const;

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

interface LayoutReport {
  cells: number;
  overlaps: string[];
  offsets: number[];
  pageOverflow: number;
  containerOverflow: number;
}

/** Mide las celdas de formulario visibles dentro de `rootSelector` (la página o el diálogo). */
async function measure(page: Page, rootSelector: string): Promise<LayoutReport> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector) ?? document.body;
    const cells = [...root.querySelectorAll<HTMLElement>('[data-slot="form-cell"]')].filter(
      (el) => el.offsetParent !== null,
    );
    const rect = (el: Element) => el.getBoundingClientRect();
    const overlaps: string[] = [];
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        const a = rect(cells[i]!);
        const b = rect(cells[j]!);
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) {
          overlaps.push(
            `${cells[i]!.textContent?.slice(0, 24) ?? ''} × ${cells[j]!.textContent?.slice(0, 24) ?? ''}`,
          );
        }
      }
    }
    // Distancia del primer control (input/select/botón) al borde superior de su celda.
    const offsets = cells
      .map((cell) => {
        const control = cell.querySelector<HTMLElement>('input, select, textarea, button');
        return control ? Math.round(rect(control).top - rect(cell).top) : null;
      })
      .filter((v): v is number => v !== null);
    const container = root as HTMLElement;
    return {
      cells: cells.length,
      overlaps,
      offsets,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      containerOverflow: container.scrollWidth - container.clientWidth,
    };
  }, rootSelector);
}

function expectClean(report: LayoutReport, label: string, checkPage = true) {
  expect(report.cells, `${label}: no encontró celdas de formulario`).toBeGreaterThan(3);
  expect(report.overlaps, `${label}: celdas que se pisan`).toEqual([]);
  // El rótulo mide siempre lo mismo: todos los controles arrancan a la misma distancia.
  const distinct = [...new Set(report.offsets)];
  expect(distinct.length, `${label}: distancias rótulo→control ${distinct.join(', ')} px`).toBe(1);
  // Con un diálogo abierto se mide el diálogo: la página de atrás (el catálogo, con datos de todas
  // las corridas) no es lo que se prueba acá.
  if (checkPage) {
    expect(report.pageOverflow, `${label}: scroll horizontal de la página`).toBeLessThanOrEqual(0);
  }
  expect(
    report.containerOverflow,
    `${label}: scroll horizontal del contenedor`,
  ).toBeLessThanOrEqual(0);
}

for (const viewport of VIEWPORTS) {
  test.describe(`Formularios a ${String(viewport.width)} px`, () => {
    test.use({ viewport });

    test('el diálogo de producto (coberturas y drywall) no se pisa ni desalinea', async ({
      page,
    }) => {
      await loginAsAdmin(page);
      await page.goto('/catalogo');
      await expect(page.getByRole('heading', { name: 'Catálogo', exact: true })).toBeVisible({
        timeout: 60_000,
      });

      // Coberturas Aluzinc, subtipo «Plancha»: es el diálogo con más campos y más ayuda.
      await page.getByRole('tab', { name: 'Coberturas Aluzinc' }).click();
      await page.getByRole('button', { name: 'Nuevo producto' }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('Subtipo de cobertura')).toBeVisible();
      await dialog
        .getByRole('combobox', { name: /Subtipo/ })
        .click()
        .catch(() => undefined);
      const plancha = page.getByRole('option', { name: /Plancha/ });
      if (await plancha.count()) await plancha.first().click();
      await dialog
        .getByPlaceholder('3000')
        .fill('3')
        .catch(() => undefined);
      expectClean(await measure(page, '[role="dialog"]'), 'ProductDialog coberturas', false);
      await page.keyboard.press('Escape');

      // Drywall: ancho, largo y peso de la pieza en una fila.
      await page.getByRole('tab', { name: 'Drywall' }).click();
      await page.getByRole('button', { name: 'Nuevo producto' }).first().click();
      await expect(page.getByRole('dialog').getByText('Peso de la pieza (kg)')).toBeVisible();
      expectClean(await measure(page, '[role="dialog"]'), 'ProductDialog drywall', false);
      await page.keyboard.press('Escape');
    });

    test('cotización, despacho y comprobante nuevos', async ({ page }) => {
      await loginAsAdmin(page);
      for (const [path, heading] of [
        ['/cotizaciones/nueva', /Nueva cotización/],
        ['/despachos/nuevo', /Nuevo despacho/],
        ['/comprobantes/nuevo', /Nuevo comprobante/],
      ] as const) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading })).toBeVisible({
          timeout: 60_000,
        });
        expectClean(await measure(page, 'main'), path);
      }
    });
  });
}
