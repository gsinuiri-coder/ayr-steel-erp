import { expect, test, type Page } from '@playwright/test';
import { adminApi, adminCredentials, postJson } from '../helpers/api';
import { uniqueDocumentNumber } from '../helpers/production';
import { createQuotation, createSellableProduct, type CustomerDto } from '../helpers/sales';

/**
 * Centinela del layout: **la página nunca scrollea en horizontal** a 1366 × 768 (S11, D-179).
 *
 * Por qué existe. `SidebarInset` (`apps/web/src/components/ui/sidebar.tsx`) no tenía `min-w-0`,
 * así que el panel de contenido no bajaba de su ancho mínimo automático y quedaba tan ancho como
 * la ventana **además** del menú lateral de 256 px. Toda la app scrolleaba esos 256 px en
 * horizontal y en una laptop de 1366 × 768 —la máquina del mostrador— los botones de acción de
 * cada lista quedaban fuera de la ventana. El defecto estuvo desde el primer día y ningún caso de
 * la suite lo vio: los tests buscan por rol y Playwright scrollea solo hasta el elemento antes de
 * clickearlo, así que una barra horizontal de más nunca los molestó.
 *
 * Qué mide, y qué **no**. Mide el desborde del documento (`scrollWidth - clientWidth` de
 * `<html>`): «¿se corrió la ventana entera?». No mide el ancho de las tablas: una tabla ancha
 * **sí** scrollea dentro de su contenedor (`[data-slot=table-container]`, con `overflow-x: auto`)
 * y eso es correcto y deseado. Lo que no puede pasar es que scrollee la **página**, porque
 * entonces se van de pantalla la barra de acciones y el menú, no solo unas columnas.
 *
 * Cuánto muerde cada caso, medido (no supuesto) a 1366 px sobre `/cotizaciones` con una razón
 * social de cien caracteres, deshaciendo las piezas del arreglo una por una desde el navegador:
 *
 * | escenario                                   | desborde |
 * | ------------------------------------------- | -------- |
 * | como está hoy                               | 0 px     |
 * | sin `min-w-0` en `SidebarInset`             | 0 px     |
 * | con `min-w-0` pero sin el recorte del nombre| 0 px     |
 * | sin `min-w-0` **y** sin el recorte          | 256 px   |
 *
 * O sea: las dos piezas de S11/B2 son **defensas redundantes** y el desborde solo vuelve si se
 * caen las dos. Por eso el archivo tiene tres clases de caso y no una sola:
 *
 * 1. **La invariante en cinco rutas** (solo lectura, sin datos). Es la que le importa a quien usa
 *    la app y la que atrapa cualquier contenido ancho nuevo que se cuele fuera de un contenedor
 *    con `overflow-x: auto`. Con las listas vacías el contenido es angosto y ninguna de las dos
 *    piezas del arreglo está en juego: acá la invariante se **vigila**, no se pone a prueba.
 * 2. **La misma invariante con el contenido que sí desbordaba**: una cotización de un cliente con
 *    razón social larga, que es el caso exacto que medía 1622 px de ancho antes de S11. Este sí
 *    pone a prueba el recorte de la celda y el clipping del contenedor de la tabla.
 * 3. **El `min-w-0` en sí**, por estilo calculado. Va contra la implementación a propósito: está
 *    medido arriba que **ninguna aserción de comportamiento lo atrapa sola**, porque la otra mitad
 *    del arreglo tapa el síntoma. Sin este caso, borrar esa clase en un refactor —el componente es
 *    de shadcn/ui, se regenera y se reordena— no rompe nada hasta que además alguien toque la
 *    celda del cliente, y para entonces el defecto no se parece en nada a su causa.
 */

test.use({ viewport: { width: 1366, height: 768 } });

const isProduction = !!process.env.E2E_BASE_URL;

/** Cada ruta con el encabezado que confirma que terminó de pintarse antes de medir. */
const ROUTES: { path: string; heading: string }[] = [
  { path: '/', heading: 'Panel' },
  { path: '/cotizaciones', heading: 'Cotizaciones' },
  { path: '/pedidos', heading: 'Pedidos' },
  { path: '/bobinas', heading: 'Bobinas' },
  { path: '/despachos/nuevo', heading: 'Nuevo despacho' },
];

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  const logged = page.waitForResponse(
    (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Ingresar' }).click();
  expect((await logged).ok(), 'El login del admin debía responder 2xx').toBe(true);
  // El `expect.timeout` de 10 s del config no alcanza: con el App Router la URL recién cambia
  // cuando llega el RSC del destino, y en modo dev el panel lo compila el primer visitante de la
  // corrida. El minuto es holgura de compilación, no de la app.
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

/** Cuántos píxeles se corre la ventana en horizontal. Cero es lo único aceptable. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * Se sondea en vez de medir una sola vez porque los datos llegan después del primer pintado y
 * podrían ensanchar la página un instante. Un desborde real no se va solo: si lo hay, el sondeo
 * falla con los píxeles exactos que sobran (256 era el ancho del menú, la firma del defecto).
 */
async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  await expect
    .poll(() => horizontalOverflow(page), {
      message:
        `${where} scrollea en horizontal a 1366 px: sobran los píxeles de abajo. Revisar que ` +
        '`SidebarInset` siga teniendo `min-w-0` (apps/web/src/components/ui/sidebar.tsx, D-179) ' +
        'y que ningún contenido ancho quede fuera de un contenedor con `overflow-x: auto`.',
      timeout: 15_000,
      intervals: [300, 700, 1_500],
    })
    .toBe(0);
}

async function gotoAndWait(page: Page, path: string, heading: string): Promise<void> {
  await page.goto(path);
  // En modo dev cada ruta la compila su primer visitante; el encabezado es la señal de que el
  // layout ya está pintado y tiene sentido medirlo.
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible({
    timeout: 60_000,
  });
}

test.describe('D-179 — la app entra en una pantalla de 1366 px', () => {
  for (const { path, heading } of ROUTES) {
    test(`${path} no scrollea en horizontal a 1366 x 768`, async ({ page }) => {
      await loginAsAdmin(page);
      await gotoAndWait(page, path, heading);
      await expectNoHorizontalScroll(page, `La página ${path}`);
    });
  }

  test('una cotización con razón social larga no desborda la página, solo su propia tabla', async ({
    page,
    baseURL,
  }) => {
    test.skip(
      isProduction,
      'Crea un cliente, un producto y una cotización: nunca contra producción (D-126, regla dura 9).',
    );
    const api = await adminApi(baseURL!);
    // Cien caracteres: el largo de una razón social real de S.A.C. con rubro y todo, que es lo
    // que empujaba la tabla de cotizaciones 363 px más allá del ancho disponible. El prefijo
    // `E2E ` es el que reconocen las purgas de la suite.
    const name =
      'E2E CORPORACION INDUSTRIAL DE SERVICIOS METALMECANICOS Y LOGISTICOS DEL PERU SOCIEDAD ANONIMA';
    const customer = await postJson<CustomerDto>(api, '/api/customers', {
      docType: 'RUC',
      docNumber: `20${uniqueDocumentNumber()}`,
      name,
      address: 'Av. Prueba 123, Lima',
      creditDays: 0,
    });
    const product = await createSellableProduct(api, {
      lineCode: 'drywall',
      listPricePen: '10.00',
    });
    await createQuotation(api, {
      customerId: customer.id,
      businessLine: 'drywall',
      productId: product.id,
      qty: '10',
    });

    await loginAsAdmin(page);
    await gotoAndWait(page, '/cotizaciones', 'Cotizaciones');
    // La fila tiene que estar pintada antes de medir: es la que trae el contenido ancho. El
    // nombre se muestra recortado con elipsis (queda entero en el `title`), así que se lo busca
    // por su comienzo y no completo.
    await expect(page.getByText(name.slice(0, 30)).first()).toBeVisible({ timeout: 30_000 });

    await expectNoHorizontalScroll(page, 'La lista de cotizaciones con una razón social larga');
  });

  test('el panel de contenido puede encogerse por debajo de su ancho mínimo automático', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await gotoAndWait(page, '/cotizaciones', 'Cotizaciones');

    // `min-width: auto` en un ítem flex significa «no me encojas por debajo de mi contenido», y
    // es exactamente lo que hacía que el panel quedara tan ancho como la ventana al lado del
    // menú. `min-w-0` lo baja a `0px`. Se lee el estilo calculado y no la lista de clases para
    // que el caso siga valiendo si mañana la regla llega por otro camino (CSS propio, otra
    // utilidad, un `style` en línea): lo que se exige es el efecto, no el nombre de la clase.
    const minWidth = await page
      .locator('[data-slot=sidebar-inset]')
      .evaluate((el) => getComputedStyle(el).minWidth);
    expect(
      minWidth,
      'El panel de contenido volvió a tener ancho mínimo automático: sin `min-w-0` la app ' +
        'scrollea 256 px en horizontal en cuanto una pantalla tenga contenido ancho (D-179).',
    ).not.toBe('auto');
  });
});
