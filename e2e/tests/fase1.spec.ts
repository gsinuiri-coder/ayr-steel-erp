import { expect, test } from '@playwright/test';
import { adminApi, createUser } from '../helpers/api';
import { loginAndSetPassword } from '../helpers/ui';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Contra producción estos escenarios (todos escriben datos) solo corren si se piden
 * de forma explícita (`pnpm e2e:prod`), igual que `auth.spec.ts` (D-024). Además de
 * los usuarios efímeros (limpiados por `cleanup-e2e-users.ts`), estos tests tocan
 * `finishes`/`products`/`pricing_settings` reales: cada uno revierte lo que cambió
 * en un `finally`, aunque el test falle a mitad de camino.
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

test.describe('Fase 1 — maestros, catálogo, importación, márgenes', () => {
  test.skip(skipWrites, 'Crea datos: en produccion solo con pnpm e2e:prod');

  test('un administrador crea un acabado desde la UI (RF-25)', async ({ page, baseURL }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');

    const code = `E2E${Date.now()}`.slice(0, 20);
    try {
      await page.getByRole('link', { name: 'Acabados' }).click();
      await expect(page.getByRole('heading', { name: 'Acabados' })).toBeVisible();

      await page.getByRole('button', { name: 'Nuevo acabado' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Código').fill(code);
      await dialog.getByLabel('Nombre').fill('Acabado E2E');
      await dialog.getByLabel('Factor de densidad').fill('7.85');
      await dialog.getByRole('button', { name: 'Crear acabado' }).click();

      await expect(dialog).toBeHidden();
      const row = page.getByRole('row').filter({ hasText: code });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Activo');
    } finally {
      if (isProduction) {
        const list = await api.get('/api/finishes');
        const found = ((await list.json()) as { id: string; code: string }[]).find(
          (f) => f.code === code,
        );
        if (found) await api.patch(`/api/finishes/${found.id}`, { data: { isActive: false } });
      }
    }
  });

  test('un administrador crea un producto de catálogo (RF-50)', async ({ page, baseURL }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');

    const sku = `SKU-${Date.now()}`;
    try {
      await page.getByRole('link', { name: 'Catálogo' }).click();
      await expect(page.getByRole('heading', { name: 'Catálogo' })).toBeVisible();
      await page.getByRole('tab', { name: 'Drywall' }).click();

      await page.getByRole('button', { name: 'Nuevo producto' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('SKU').fill(sku);
      await dialog.getByLabel('Nombre').fill('Producto E2E');
      await dialog.getByLabel('Unidad').fill('unidad');
      await dialog.getByRole('button', { name: 'Crear producto' }).click();

      await expect(dialog).toBeHidden();
      const row = page.getByRole('row').filter({ hasText: sku });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Fabricado');
      await expect(row).toContainText('Activo');
    } finally {
      if (isProduction) {
        const list = await api.get('/api/catalog');
        const found = ((await list.json()) as { id: string; sku: string }[]).find(
          (p) => p.sku === sku,
        );
        if (found) await api.patch(`/api/catalog/${found.id}`, { data: { isActive: false } });
      }
    }
  });

  test('importar planilla con una fila mala, corregirla y confirmar (RF-52)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');

    const goodSku = `IMP-OK-${Date.now()}`;
    const badSku = `IMP-BAD-${Date.now()}`;
    const csv = [
      'Línea,SKU,Nombre,Unidad,Origen (MANUFACTURED/PURCHASED)',
      `drywall,${goodSku},Producto bueno,unidad,MANUFACTURED`,
      `zzz,${badSku},Producto malo,kg,PURCHASED`,
    ].join('\n');

    try {
      await page.goto('/catalogo');
      await expect(page.getByRole('heading', { name: 'Catálogo' })).toBeVisible();
      await page.getByRole('button', { name: 'Importar' }).click();

      const dialog = page.getByRole('dialog');
      await dialog
        .locator('input[type="file"]')
        .setInputFiles({ name: 'productos.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });

      // Fila 1 válida, fila 2 con línea de negocio desconocida.
      await expect(dialog.getByText('Línea de negocio desconocida: "zzz"')).toBeVisible();
      await expect(dialog.getByText('1 de 2 filas listas para confirmar.')).toBeVisible();

      // Corrige la fila 2: línea válida.
      const badRowLineField = dialog.getByLabel(`Línea fila 2`);
      await badRowLineField.fill('drywall');
      await badRowLineField.blur();
      await expect(dialog.getByText('2 de 2 filas listas para confirmar.')).toBeVisible();

      await dialog.getByRole('button', { name: 'Confirmar 2 filas' }).click();
      await expect(page.getByText('2 de 2 filas importadas')).toBeVisible();
      await dialog.getByRole('button', { name: 'Cerrar' }).click();

      await expect(dialog).toBeHidden();
      await expect(page.getByRole('row').filter({ hasText: goodSku })).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: badSku })).toBeVisible();
    } finally {
      if (isProduction) {
        const list = await api.get('/api/catalog');
        const products = (await list.json()) as { id: string; sku: string }[];
        for (const sku of [goodSku, badSku]) {
          const found = products.find((p) => p.sku === sku);
          if (found) await api.patch(`/api/catalog/${found.id}`, { data: { isActive: false } });
        }
      }
    }
  });

  test('un administrador cambia el margen de una línea (D-032)', async ({ page, baseURL }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, 'ClaveAdminE2E-2026');

    const settingsRes = await api.get('/api/pricing');
    const settings = (await settingsRes.json()) as {
      businessLineId: string;
      businessLineCode: string;
      marginPct: string;
    }[];
    const drywall = settings.find((s) => s.businessLineCode === 'drywall');
    if (!drywall) throw new Error('No se encontró la configuración de márgenes de Drywall');
    const originalMargin = drywall.marginPct;

    try {
      await page.getByRole('link', { name: 'Márgenes' }).click();
      await expect(page.getByRole('heading', { name: 'Márgenes' })).toBeVisible();

      const row = page.getByRole('row').filter({ hasText: 'Drywall' });
      const marginField = row.getByLabel('Margen sugerido de Drywall');
      // Corridas locales repetidas no resetean la DB (solo CI lo hace): el valor
      // objetivo se calcula distinto al actual para que el botón Guardar se habilite.
      const current = await marginField.inputValue();
      const newValue = current === '25.0000' ? '30.0000' : '25.0000';
      await marginField.fill(newValue);
      await marginField.blur();
      await row.getByRole('button', { name: 'Guardar' }).click();

      await expect(page.getByText('Margen de Drywall actualizado')).toBeVisible();
      await expect(marginField).toHaveValue(newValue);
    } finally {
      // En producción, el margen de una línea real no debe quedar en un valor de
      // prueba: se restaura el que había antes de este test, pase lo que pase.
      if (isProduction) {
        await api.patch(`/api/pricing/${drywall.businessLineId}`, {
          data: { marginPct: originalMargin },
        });
      }
    }
  });

  test('un vendedor no ve /configuracion (RF-02)', async ({ page, baseURL }) => {
    const api = await adminApi(baseURL!);
    const vendedor = await createUser(api, 'VENDEDOR');
    await loginAndSetPassword(page, vendedor, 'ClaveVendedorE2E-2026');

    await expect(page.getByRole('link', { name: 'Márgenes' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Tipo de cambio' })).toHaveCount(0);

    await page.goto('/configuracion/margenes');
    await expect(page.getByText('No tienes permiso para ver esta sección.')).toBeVisible();
  });
});
