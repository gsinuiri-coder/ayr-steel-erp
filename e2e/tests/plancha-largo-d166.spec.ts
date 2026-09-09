import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, getJson } from '../helpers/api';
import { createCustomer } from '../helpers/sales';
import {
  createColor,
  createRoofingFinish,
  createRoofingProduct,
  purgeRoofingTrail,
} from '../helpers/roofing';
import { postExpectingError } from '../helpers/production';

/**
 * **D-166 — el largo de catálogo de una plancha va en milímetros, y tiene que ser posible.**
 *
 * El defecto que encontró el dueño: `PL028ROJO`, una plancha de 3 metros, tenía `3.00` en el
 * catálogo porque el campo pide **milímetros** y el resto de la pantalla de coberturas trabaja
 * en **metros**. En Nueva cotización el bloque de D-161 mostraba «Largo (m) 0.00» y «0.030 m
 * lineales», y diez planchas a S/ 11 el metro salían **S/ 0.28** en vez de S/ 330. Ningún error
 * y ningún aviso: un documento mil veces más barato que solo se cazaba leyendo el importe.
 *
 * Las tres planchas del catálogo del dueño estaban cargadas así, o sea que no fue un desliz
 * sino una trampa del campo.
 *
 * Estos casos cubren las dos mitades del arreglo **por la pantalla que se usa de verdad**:
 *
 * - el catálogo traduce el número a metros mientras se tipea y no deja guardar el imposible —
 *   es el momento en el que la confusión se puede desarmar sin consecuencias;
 * - la cotización de una plancha bien cargada da los metros y el importe correctos, que es la
 *   regresión directa de la captura.
 *
 * Lo que **no** se puede montar acá es un producto ya guardado con el largo roto: desde D-166
 * ninguna ruta de la app lo produce, y escribirlo por debajo ataría la suite a Docker (en CI
 * corre contra Neon). Ese camino —`assertUsableFixedLength`, la línea que se niega a cotizar
 * un maestro que miente— está cubierto en `apps/api/src/sales/fixed-length-plausible.spec.ts`,
 * que es donde se puede probar sin base.
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea productos y cotizaciones: nunca contra producción (D-126, regla dura 9).',
);

// Monta el escenario por API y encima navega a rutas que el Next de desarrollo compila recién
// en el primer visitante de la corrida.
test.describe.configure({ timeout: 240_000 });

async function loginAsAdmin(page: Page) {
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

interface BusinessLineRow {
  id: string;
  code: string;
}

test.describe('D-166 — el largo de la plancha va en milímetros', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('el catálogo rechaza el largo tipeado en metros y el mensaje dice la unidad', async () => {
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const lines = await getJson<BusinessLineRow[]>(api, '/api/business-lines');
    const roofing = lines.find((l) => l.code === 'metallic-roofing');
    expect(roofing, 'la línea de coberturas tiene que existir en el seed').toBeDefined();

    try {
      // Exactamente lo que hizo el dueño tres veces: "3" queriendo decir 3 metros.
      const failed = await postExpectingError(api, '/api/catalog', {
        businessLineId: roofing!.id,
        sku: `E2E-PL${Date.now().toString().slice(-6)}`,
        name: 'Plancha E2E con el largo en metros',
        unit: 'NIU',
        source: 'MANUFACTURED',
        listPricePen: '30',
        finishId: finish.id,
        colorId: color.id,
        thicknessMm: '0.28',
        widthMm: '1220',
        roofingKind: 'PLANCHA',
        lengthMm: '3',
      });
      expect(failed.status).toBe(400);
      // El mensaje traduce el número y nombra la unidad. Decir solo "fuera de rango" deja a
      // quien lo lee sin saber qué esperaba el campo, que es la mitad de la confusión.
      expect(failed.message).toContain('milímetros');
      expect(failed.message).toContain('3000');
      expect(failed.message).toContain('0.003');

      // Y el mismo producto con el largo bien cargado entra sin ruido.
      const { product } = await createRoofingProduct(api, {
        finishId: finish.id,
        colorId: color.id,
        thicknessMm: '0.28',
        pieceLengthMm: '3000',
      });
      expect(product.lengthMm).toBe('3000.00');
      await purgeRoofingTrail(api, { productIds: [product.id] });
    } finally {
      await purgeRoofingTrail(api, { finishId: finish.id, colorId: color.id });
    }
  });

  test('el diálogo del catálogo traduce el largo a metros mientras se tipea', async ({ page }) => {
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);

    try {
      await loginAsAdmin(page);
      await page.goto('/catalogo');
      // El catálogo se mira por línea de negocio; la de coberturas es la que tiene planchas.
      await page.getByRole('tab', { name: /Metallic Roofing|Coberturas/i }).click();
      await page.getByRole('button', { name: /Nuevo producto/i }).click();

      await page.getByLabel('Subtipo de cobertura').click();
      await page.getByRole('option', { name: /Plancha/i }).click();

      const largo = page.getByLabel('Largo de la plancha (mm)');
      await expect(largo).toBeVisible();

      // El número tipeado en metros: la pantalla lo traduce y avisa en el acto. Es lo que
      // habría desarmado la confusión cuando las tres planchas se cargaron así.
      await largo.fill('3');
      await expect(page.getByText('= 0.003 m', { exact: false })).toBeVisible();
      await expect(page.getByText(/fuera de rango/i)).toBeVisible();
      await expect(page.getByText(/milímetros/i)).toBeVisible();

      // Y con el largo en milímetros el aviso desaparece y la traducción cierra.
      await largo.fill('3000');
      await expect(page.getByText('= 3.000 m', { exact: false })).toBeVisible();
      await expect(page.getByText(/fuera de rango/i)).toHaveCount(0);
    } finally {
      await purgeRoofingTrail(api, { finishId: finish.id, colorId: color.id });
    }
  });

  test('la cotización de una plancha de 3 m muestra 30 m lineales y cobra S/ 330', async ({
    page,
  }) => {
    const finish = await createRoofingFinish(api);
    const color = await createColor(api);
    const customer = await createCustomer(api);
    const { product } = await createRoofingProduct(api, {
      finishId: finish.id,
      colorId: color.id,
      thicknessMm: '0.28',
      pieceLengthMm: '3000',
      listPricePen: '33',
    });

    try {
      await loginAsAdmin(page);
      await page.goto('/cotizaciones/nueva');

      await page.getByLabel('Cliente').click();
      await page.getByRole('option', { name: customer.name }).click();
      await page.getByRole('button', { name: /Agregar línea/i }).click();

      // El selector de producto está apagado hasta que la línea tiene línea de negocio: es
      // por línea, no del documento (D-119).
      await page.getByLabel('Línea de negocio de la línea 1').click();
      await page.getByRole('option', { name: 'Metallic Roofing' }).click();
      await page.getByLabel('Producto de la línea 1').click();
      await page.getByRole('option', { name: new RegExp(product.sku) }).click();

      // **La regresión de la captura, en una línea**: el largo bloqueado tiene que traer el
      // del SKU en metros. Antes decía 0.00 porque el catálogo tenía 3 mm.
      await expect(page.getByLabel('Largo (m)')).toHaveValue('3.00');

      await page.getByLabel('Planchas de la línea 1').fill('10');
      // 10 planchas × 3 m = 30 m lineales. Antes salían 0.030.
      await expect(page.getByText('30.000 m lineales')).toBeVisible();

      // Y el importe: S/ 11 el metro (con IGV) × 3 m × 10 planchas = S/ 330.
      await page.getByLabel('Precio por metro de la línea 1').fill('11');
      await expect(page.getByText('S/ 330.00').first()).toBeVisible();
    } finally {
      await purgeRoofingTrail(api, {
        productIds: [product.id],
        finishId: finish.id,
        colorId: color.id,
      });
    }
  });
});
