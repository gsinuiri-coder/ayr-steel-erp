import { expect, test, type Page } from '@playwright/test';
import { businessToday, type SalesMarginDto, type SalesMarginOrderDto } from '@ayr/shared';
import { adminCredentials } from '../helpers/api';

/**
 * cc32 (corte 1) — plantilla de reportes, con Ventas y margen como primer reporte que la usa.
 *
 * - El periodo va siempre en la URL, también el predeterminado, y se mantiene al pasar de un
 *   reporte a otro (`sessionStorage` y los enlaces de `/reportes`).
 * - La tabla ordena por columna con el orden en la URL, abre el detalle con chevron y lleva el
 *   total al pie; «Ver por» Vendedor suma lo mismo que la tabla por pedido.
 * - Un rango inválido muestra el error y ningún esqueleto.
 *
 * Las filas del reporte salen de un fixture (`page.route`): lo que se prueba es la pantalla, no el
 * cálculo del API, que ya cubren sus unitarios y los specs de cc23. Así el orden y los totales son
 * exactos sin depender de qué ventas haya en la base. Solo lee: nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Suite local y CI: nunca contra producción (D-126).');

async function loginAsAdmin(page: Page): Promise<void> {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Un número estable por nombre, para los ids del fixture. */
function nameKey(name: string): number {
  let k = 0;
  for (const ch of name) k = (k * 31 + ch.charCodeAt(0)) % 9_000;
  return k;
}

function order(
  n: number,
  customer: string,
  seller: string,
  sales: string,
  cost: string,
  margin: string,
  pct: string,
  status: SalesMarginOrderDto['costStatus'] = 'COMPLETO',
): SalesMarginOrderDto {
  return {
    salesOrderId: uuid(n),
    orderCode: `PED-E2E-00${String(n)}`,
    // cc40 (D-586): «Ver por» agrupa por id; un id por nombre, como en la base.
    customerId: uuid(200 + nameKey(customer)),
    customerName: customer,
    customerDocNumber: `20${String(200 + nameKey(customer)).padStart(9, '0')}`,
    sellerId: uuid(300 + nameKey(seller)),
    sellerName: seller,
    salesPen: sales,
    costPen: cost,
    opMaterialCostPen: '125.50',
    marginPen: margin,
    marginPct: pct,
    costStatus: status,
    inTotals: true,
    documents: [
      {
        id: uuid(100 + n),
        number: `F001-0000000${String(n)}`,
        docType: 'FACTURA',
        status: 'ACCEPTED',
        origin: 'ISSUED_HERE',
        issueDate: '2026-10-06',
        salesPen: sales,
        costPen: cost,
        marginPen: margin,
        marginPct: pct,
      },
    ],
  };
}

/** Cuatro pedidos de dos vendedores; la venta suma S/ 13,768.80. */
function fixture(from: string, to: string): SalesMarginDto {
  return {
    from,
    to,
    orders: [
      order(1, 'Constructora Los Álamos', 'Gabriela R.', '1455.25', '1020.40', '434.85', '29.88'),
      order(2, 'Techos del Sur', 'Marco T.', '7135.59', '5280.34', '1855.25', '26.00'),
      order(3, 'Drywall Norte', 'Gabriela R.', '3355.93', '2651.18', '704.75', '21.00'),
      order(4, 'Inversiones Rímac', 'Marco T.', '1822.03', '1603.39', '218.64', '12.00', 'PARCIAL'),
    ],
    totalsByLine: [
      {
        businessLine: 'drywall',
        salesPen: '13768.80',
        costPen: '10555.31',
        marginPen: '3213.49',
        marginPct: '23.34',
      },
    ],
    totals: {
      salesPen: '13768.80',
      noCostSalesPen: '0.00',
      costPen: '10555.31',
      marginPen: '3213.49',
      marginPct: '23.34',
      partialOrderCount: 1,
      excludedOrderCount: 0,
      excludedSalesPen: '0.00',
      untraceableOrderCount: 0,
      untraceableSalesPen: '0.00',
      roundingPen: '0.0000',
    },
  };
}

/**
 * Responde el reporte con el fixture, con el periodo que la pantalla pidió. `hold`: las
 * consultas que cumplen la condición esperan hasta que se llame a `release` (para ver la
 * pantalla mientras carga).
 */
async function mockSalesMargin(
  page: Page,
  hold: (params: URLSearchParams) => boolean = () => false,
): Promise<{ release: () => void }> {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === '/api/reports/sales-margin',
    async (route) => {
      const url = new URL(route.request().url());
      if (hold(url.searchParams)) await held;
      await route.fulfill({
        json: fixture(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? ''),
      });
    },
  );
  return {
    release: () => {
      release();
    },
  };
}

function firstOfMonth(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

function previousMonth(today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${String(y)}-${mm}-01`, to: `${String(y)}-${mm}-${String(last)}` };
}

const footer = (page: Page) => page.getByTestId('tabla-ventas-margen-total');

test.describe('Plantilla de reportes (cc32)', () => {
  test('el periodo predeterminado queda en la URL y se mantiene al pasar por /reportes', async ({
    page,
  }) => {
    const today = businessToday();
    await loginAsAdmin(page);
    await mockSalesMargin(page);

    // Sin parámetros, la URL se completa con el mes en curso.
    await page.goto('/reportes/ventas-margen');
    await expect(page).toHaveURL(`/reportes/ventas-margen?from=${firstOfMonth(today)}&to=${today}`);
    await expect(page.getByRole('button', { name: 'Este mes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('periodo-rango')).toHaveText(
      `Del 01/${today.slice(5, 7)}/${today.slice(0, 4)} al ${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`,
    );
    // La ruta lleva al inicio de Reportes.
    await expect(
      page.getByRole('navigation', { name: 'Ruta' }).getByRole('link', { name: 'Reportes' }),
    ).toHaveAttribute('href', '/reportes');

    // Otro periodo: queda en la URL y se recuerda.
    const prev = previousMonth(today);
    await page.getByRole('button', { name: 'Mes anterior' }).click();
    await expect(page).toHaveURL(`/reportes/ventas-margen?from=${prev.from}&to=${prev.to}`);
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
      'href',
      `/api/reports/sales-margin/xlsx?from=${prev.from}&to=${prev.to}`,
    );

    // /reportes: los enlaces llevan el periodo elegido.
    await page.goto('/reportes');
    const card = page.getByTestId('tarjeta-reporte').filter({ hasText: 'Ventas y margen' });
    await expect(card).toHaveAttribute(
      'href',
      `/reportes/ventas-margen?from=${prev.from}&to=${prev.to}`,
    );
    await card.click();
    await expect(page).toHaveURL(`/reportes/ventas-margen?from=${prev.from}&to=${prev.to}`);
    await expect(page.getByRole('button', { name: 'Mes anterior' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Y al abrir el reporte sin parámetros, se completa con el periodo recordado.
    await page.goto('/reportes/ventas-margen');
    await expect(page).toHaveURL(`/reportes/ventas-margen?from=${prev.from}&to=${prev.to}`);
  });

  test('ordenar por una columna cambia el orden y queda en la URL; el detalle se abre con chevron', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockSalesMargin(page);
    await page.goto('/reportes/ventas-margen?from=2026-10-01&to=2026-10-07');

    const rows = page.getByTestId('fila-pedido');
    await expect(rows).toHaveCount(4);
    // Sin orden elegido, como llegan del API.
    await expect(rows.first()).toContainText('PED-E2E-001');

    await page.getByRole('button', { name: 'Venta (S/)' }).click();
    // El ascendente es el sentido por defecto y no se escribe (URL limpia, D-289).
    await expect(page).toHaveURL(/[?&]sort=sales$/);
    await expect(rows.first()).toContainText('PED-E2E-001');
    await expect(rows.last()).toContainText('PED-E2E-002');

    await page.getByRole('button', { name: 'Venta (S/)' }).click();
    await expect(page).toHaveURL(/sort=sales&dir=desc/);
    await expect(rows.first()).toContainText('PED-E2E-002');
    await expect(rows.last()).toContainText('PED-E2E-001');

    // Refrescar conserva el orden.
    await page.reload();
    await expect(rows.first()).toContainText('PED-E2E-002');

    // Sin columnas repetidas ni «Material de OPs» en la tabla.
    const headers = page.getByTestId('tabla-ventas-margen').locator('thead th');
    await expect(headers).toHaveText([
      'Pedido',
      'Cliente',
      'Vendedor',
      'Venta (S/)',
      'Costo (S/)',
      'Margen (S/)',
      'Margen %',
      'Costo registrado',
    ]);

    // Códigos como enlace y detalle con chevron.
    await expect(page.getByRole('link', { name: 'PED-E2E-001' })).toHaveAttribute(
      'href',
      `/pedidos/${uuid(1)}`,
    );
    await expect(page.getByRole('link', { name: 'F001-00000001' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Ver detalle de PED-E2E-001' }).click();
    await expect(page.getByRole('link', { name: 'F001-00000001' })).toHaveAttribute(
      'href',
      `/comprobantes/${uuid(101)}`,
    );
    await expect(page.getByTestId('detalle-comprobante')).toContainText('Factura · 06/10/2026');
    await expect(page.getByTestId('detalle-material')).toContainText('S/ 125.50');
    await page.getByRole('button', { name: 'Ocultar detalle de PED-E2E-001' }).click();
    await expect(page.getByTestId('detalle-comprobante')).toHaveCount(0);

    // La búsqueda filtra lo cargado, sin acentos.
    await page.getByRole('searchbox', { name: 'Buscar en el reporte' }).fill('alamos');
    await expect(rows).toHaveCount(1);
    await expect(footer(page)).toContainText('Total · 1 pedido');
    await expect(footer(page).locator('[data-column="sales"]')).toHaveText('1,455.25');
  });

  test('en «Ver por Vendedor», el total al pie es igual al total general', async ({ page }) => {
    await loginAsAdmin(page);
    await mockSalesMargin(page);
    await page.goto('/reportes/ventas-margen?from=2026-10-01&to=2026-10-07');

    await expect(page.getByTestId('fila-pedido')).toHaveCount(4);
    await expect(footer(page)).toContainText('Total · 4 pedidos');
    await expect(footer(page).locator('[data-column="sales"]')).toHaveText('13,768.80');
    await expect(footer(page).locator('[data-column="cost"]')).toHaveText('10,555.31');
    await expect(footer(page).locator('[data-column="margin"]')).toHaveText('3,213.49');
    await expect(page.getByTestId('cifras-ventas-margen')).toContainText('S/ 13,768.80');

    await page
      .getByRole('group', { name: 'Ver por' })
      .getByRole('button', { name: 'Vendedor' })
      .click();
    await expect(page).toHaveURL(/ver=vendedor/);
    const groups = page.getByTestId('fila-grupo');
    await expect(groups).toHaveCount(2);
    await expect(footer(page).locator('[data-column="count"]')).toHaveText('4');
    await expect(footer(page).locator('[data-column="sales"]')).toHaveText('13,768.80');
    await expect(footer(page).locator('[data-column="cost"]')).toHaveText('10,555.31');
    await expect(footer(page).locator('[data-column="margin"]')).toHaveText('3,213.49');
    await expect(footer(page).locator('[data-column="pct"]')).toHaveText('23.34 %');

    // Cada grupo suma sus pedidos; el chevron los muestra.
    const marco = groups.filter({ hasText: 'Marco T.' });
    await expect(marco).toContainText('8,957.62');
    await page.getByRole('button', { name: 'Ver detalle de Marco T.' }).click();
    await expect(page.getByTestId('detalle-pedido')).toHaveCount(2);
    await expect(page.getByTestId('detalle-pedido').first()).toContainText('PED-E2E-002');
  });

  test('cc40: «Ver por» Cliente agrupa por id y enlaza; las tres vistas suman lo mismo; el Excel lleva la búsqueda', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    // Dos clientes distintos que se llaman igual: el 2 y el 4 pasan a ser «Techos del Sur».
    await page.route(
      (url) => url.pathname === '/api/reports/sales-margin',
      async (route) => {
        const data = fixture('2026-10-01', '2026-10-07');
        const twin = data.orders[3];
        if (twin) data.orders[3] = { ...twin, customerName: 'Techos del Sur' };
        await route.fulfill({ json: data });
      },
    );
    await page.goto('/reportes/ventas-margen?from=2026-10-01&to=2026-10-07&ver=cliente');
    const groups = page.getByTestId('fila-grupo');
    // Cuatro clientes por id, aunque dos se llamen igual.
    await expect(groups).toHaveCount(4);
    await expect(groups.filter({ hasText: 'Techos del Sur' })).toHaveCount(2);
    await expect(footer(page).locator('[data-column="sales"]')).toHaveText('13,768.80');
    // El nombre enlaza a la ficha del cliente: la lista con su RUC (D-172).
    const link = groups.first().getByRole('link', { name: 'Constructora Los Álamos' });
    await expect(link).toHaveAttribute('href', /^\/clientes\?search=20\d{9}$/);

    // Con búsqueda, Pedido, Vendedor y Cliente suman lo mismo, y el Excel la lleva.
    await page.getByLabel('Buscar en el reporte').fill('marco');
    await expect(page).toHaveURL(/search=marco/);
    await expect(footer(page).locator('[data-column="sales"]')).toHaveText('8,957.62');
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
      'href',
      '/api/reports/sales-margin/xlsx?from=2026-10-01&to=2026-10-07&search=marco',
    );
    for (const view of ['Vendedor', 'Pedido']) {
      await page
        .getByRole('group', { name: 'Ver por' })
        .getByRole('button', { name: view })
        .click();
      await expect(footer(page).locator('[data-column="sales"]')).toHaveText('8,957.62');
    }
  });

  test('mientras carga otro periodo, el dato anterior se ve marcado; otra línea no lo hereda', async ({
    page,
  }) => {
    const prev = previousMonth(businessToday());
    await loginAsAdmin(page);
    const mock = await mockSalesMargin(page, (p) => p.get('from') === prev.from);
    await page.goto('/reportes/ventas-margen?from=2026-10-01&to=2026-10-07');
    const table = page.getByTestId('tabla-ventas-margen');
    const rows = page.getByTestId('fila-pedido');
    await expect(rows).toHaveCount(4);
    await expect(table).not.toHaveAttribute('aria-busy', 'true');

    // Otro periodo en la misma pestaña: el dato anterior queda, atenuado y ocupado.
    await page.getByRole('button', { name: 'Mes anterior' }).click();
    await expect(table).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('actualizando')).toHaveText('Actualizando…');
    await expect(rows).toHaveCount(4);
    mock.release();
    await expect(table).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('actualizando')).toHaveCount(0);

    // Otra pestaña de línea: no se muestran las filas de «Todas» mientras carga.
    const drywall = await mockSalesMargin(page, (p) => p.get('businessLine') === 'drywall');
    await page.getByTestId('pestanas-linea').getByRole('tab', { name: 'Drywall' }).click();
    await expect(page).toHaveURL(/linea=drywall/);
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('actualizando')).toHaveCount(0);
    drywall.release();
    await expect(rows).toHaveCount(4);
  });

  test('un rango inválido muestra el error y ningún esqueleto', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/reportes/ventas-margen?from=2026-10-10&to=2026-10-01');
    await expect(
      page.getByText('El periodo no es válido: la fecha de inicio es posterior a la de fin.'),
    ).toBeVisible();
    await expect(page).toHaveURL('/reportes/ventas-margen?from=2026-10-10&to=2026-10-01');
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await expect(page.getByTestId('tabla-ventas-margen')).toHaveCount(0);
  });

  test('/reportes muestra las tarjetas agrupadas', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/reportes');
    await expect(page.getByRole('heading', { name: 'Reportes', level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Ruta' }).getByText('Inicio')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'Ventas y cobranza',
      'Almacén',
      'Planta',
    ]);
    const cards = page.getByTestId('tarjeta-reporte');
    await expect(cards).toHaveCount(7);
    await expect(cards.filter({ hasText: 'Cuentas por cobrar' })).toContainText(
      'Quién debe, cuánto y desde cuándo.',
    );
    await expect(cards.filter({ hasText: 'Cuentas por cobrar' })).toHaveAttribute(
      'href',
      '/reportes/cuentas-por-cobrar',
    );
  });
});
