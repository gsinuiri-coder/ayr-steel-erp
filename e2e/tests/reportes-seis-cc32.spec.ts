import { expect, test, type Page } from '@playwright/test';
import { businessToday } from '@ayr/shared';
import {
  firstOfMonth,
  loginAsAdmin,
  mockReports,
  previousMonth,
  uuid,
} from '../helpers/report-fixtures';

/**
 * cc32 (corte 2) — los otros seis reportes sobre la plantilla del corte 1: Ventas por material,
 * Cuentas por cobrar, Inventario valorizado, Reporte mensual de bobinas, Merma por bobina y
 * Reporte de producción.
 *
 * - Merma y Producción: el periodo va en la URL también cuando es el predeterminado, y se
 *   mantiene al llegar desde Ventas y margen.
 * - Bobinas: el mes en la URL. Cuentas por cobrar e Inventario: «a hoy», sin selector.
 * - Orden por columna con el orden en la URL, total al pie que sigue a la búsqueda y rango
 *   inválido sin esqueleto. El diálogo de Ventas por material sigue abriendo desde la fila.
 *
 * Las filas salen de fixtures (`page.route`): lo que se prueba es la pantalla, no el cálculo del
 * API, que ya cubren sus unitarios y los specs de cc23..cc29. Solo lee: nunca contra producción
 * (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Suite local y CI: nunca contra producción (D-126).');

const total = (page: Page, table: string, column: string) =>
  page.getByTestId(`${table}-total`).locator(`[data-column="${column}"]`);

/* ------------------------------------------------------------------------------------- *
 * Pruebas
 * ------------------------------------------------------------------------------------- */

test.describe('Los seis reportes con la plantilla (cc32, corte 2)', () => {
  test('Merma y Producción: el periodo predeterminado queda en la URL', async ({ page }) => {
    const today = businessToday();
    await loginAsAdmin(page);
    await mockReports(page);

    for (const path of ['/reportes/merma', '/reportes/produccion']) {
      await page.goto(path);
      await expect(page).toHaveURL(`${path}?from=${firstOfMonth(today)}&to=${today}`);
      await expect(page.getByRole('button', { name: 'Este mes' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    // Producción ofrece el Excel con el periodo y la pestaña puestos.
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
      'href',
      `/api/reports/production-summary/xlsx?from=${firstOfMonth(today)}&to=${today}&businessLine=metallic-roofing`,
    );
    // Merma no tiene Excel en el API: no se muestra.
    await page.goto('/reportes/merma');
    await expect(page.getByTestId('tabla-merma')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveCount(0);
  });

  test('el periodo elegido en Ventas y margen se mantiene en Merma, Producción y Bobinas', async ({
    page,
  }) => {
    const today = businessToday();
    const prev = previousMonth(today);
    await loginAsAdmin(page);
    await mockReports(page);

    await page.goto('/reportes/ventas-margen');
    await expect(page).toHaveURL(/from=.*&to=/);
    await page.getByRole('button', { name: 'Mes anterior' }).click();
    await expect(page).toHaveURL(`/reportes/ventas-margen?from=${prev.from}&to=${prev.to}`);

    await page.goto('/reportes/merma');
    await expect(page).toHaveURL(`/reportes/merma?from=${prev.from}&to=${prev.to}`);
    await expect(page.getByRole('button', { name: 'Mes anterior' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.goto('/reportes/produccion');
    await expect(page).toHaveURL(`/reportes/produccion?from=${prev.from}&to=${prev.to}`);

    // Bobinas toma el mes del periodo.
    await page.goto('/reportes/bobinas');
    await expect(page).toHaveURL(`/reportes/bobinas?mes=${prev.month}`);

    // Y los enlaces de /reportes llevan el periodo a cada uno.
    await page.goto('/reportes');
    const card = (name: string) => page.getByTestId('tarjeta-reporte').filter({ hasText: name });
    await expect(card('Merma por bobina')).toHaveAttribute(
      'href',
      `/reportes/merma?from=${prev.from}&to=${prev.to}`,
    );
    await expect(card('Ventas por material')).toHaveAttribute(
      'href',
      `/reportes/ventas-material?from=${prev.from}&to=${prev.to}`,
    );
    await expect(card('Reporte mensual de bobinas')).toHaveAttribute(
      'href',
      `/reportes/bobinas?mes=${prev.month}`,
    );
    await expect(card('Cuentas por cobrar')).toHaveAttribute(
      'href',
      '/reportes/cuentas-por-cobrar',
    );
  });

  test('Merma: ordenar por columna queda en la URL; el total al pie sigue a la búsqueda', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockReports(page);
    await page.goto('/reportes/merma?from=2026-10-01&to=2026-10-07');

    const rows = page.getByTestId('merma-bobina');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('BOB-E2E-001');

    await page.getByRole('button', { name: 'Consumido (kg)' }).click();
    await expect(page).toHaveURL(/[?&]sort=consumed$/);
    await expect(rows.first()).toContainText('BOB-E2E-003');
    await page.getByRole('button', { name: 'Consumido (kg)' }).click();
    await expect(page).toHaveURL(/sort=consumed&dir=desc/);
    await expect(rows.first()).toContainText('BOB-E2E-002');

    // Total al pie: el del API, con separador de miles y sin unidad en la celda.
    await expect(page.getByTestId('tabla-merma-total')).toContainText('Total · 3 bobinas');
    await expect(total(page, 'tabla-merma', 'consumed')).toHaveText('3,750.75');
    await expect(total(page, 'tabla-merma', 'theoretical')).toHaveText('3,200.00');
    await expect(total(page, 'tabla-merma', 'pct')).toHaveText('1.59 %');

    // Con búsqueda, el pie suma solo lo que queda a la vista.
    await page.getByRole('searchbox', { name: 'Buscar en el reporte' }).fill('OP-E2E-002');
    await expect(rows).toHaveCount(1);
    await expect(total(page, 'tabla-merma', 'consumed')).toHaveText('2,000.25');
    await expect(total(page, 'tabla-merma', 'pct')).toHaveText('2.05 %');

    // El detalle con chevron: la orden como enlace.
    await page.getByRole('button', { name: 'Ver detalle de BOB-E2E-002' }).click();
    await expect(
      page.getByTestId('merma-produccion').getByRole('link', { name: 'OP-E2E-002' }),
    ).toHaveAttribute('href', `/produccion/${uuid(602)}`);
  });

  test('Producción: orden por columna, total al pie y «Ver por» Pedido', async ({ page }) => {
    await loginAsAdmin(page);
    await mockReports(page);
    await page.goto('/reportes/produccion?from=2026-10-01&to=2026-10-07');

    const rows = page.getByTestId('produccion-op');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('OP-E2E-101');
    await page.getByRole('button', { name: 'Salido (kg)' }).click();
    await expect(page).toHaveURL(/[?&]sort=consumed$/);
    await page.getByRole('button', { name: 'Salido (kg)' }).click();
    await expect(page).toHaveURL(/sort=consumed&dir=desc/);
    await expect(rows.first()).toContainText('OP-E2E-102');
    await expect(page.getByTestId('tabla-produccion').locator('thead th')).toHaveText([
      'Orden',
      'Pedido',
      'Producto',
      'Cantidad',
      'Teórico (kg)',
      'Salido (kg)',
      'Despunte (kg)',
      'Merma %',
      'Costo salido (S/)',
      'Costo despunte (S/)',
    ]);
    await expect(page.getByTestId('tabla-produccion-total')).toContainText('Total · 2 órdenes');
    await expect(total(page, 'tabla-produccion', 'consumed')).toHaveText('1,510.00');
    await expect(total(page, 'tabla-produccion', 'materialCost')).toHaveText('2,000.00');
    // Pedido y orden son enlaces.
    await expect(rows.first().getByRole('link', { name: 'PED-E2E-080' })).toHaveAttribute(
      'href',
      `/pedidos/${uuid(800)}`,
    );

    await page
      .getByRole('group', { name: 'Ver por' })
      .getByRole('button', { name: 'Pedido' })
      .click();
    await expect(page).toHaveURL(/ver=pedido/);
    await expect(page.getByTestId('produccion-subtotal')).toHaveCount(1);
    await expect(total(page, 'tabla-produccion', 'consumed')).toHaveText('1,510.00');
  });

  test('un rango inválido muestra el error y ningún esqueleto', async ({ page }) => {
    await loginAsAdmin(page);
    await mockReports(page);
    for (const path of ['/reportes/merma', '/reportes/produccion', '/reportes/ventas-material']) {
      await page.goto(`${path}?from=2026-10-10&to=2026-10-01`);
      await expect(
        page.getByText('El periodo no es válido: la fecha de inicio es posterior a la de fin.'),
      ).toBeVisible();
      await expect(page).toHaveURL(`${path}?from=2026-10-10&to=2026-10-01`);
      await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
      await expect(page.locator('table')).toHaveCount(0);
    }
  });

  test('Cuentas por cobrar e Inventario valorizado: «a hoy», sin selector de periodo', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockReports(page);

    await page.goto('/reportes/cuentas-por-cobrar');
    await expect(page.getByTestId('cxc-cliente')).toHaveCount(2);
    await expect(page.getByTestId('periodo')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Este mes' })).toHaveCount(0);
    await expect(page).toHaveURL('/reportes/cuentas-por-cobrar');
    // Orden por saldo y total al pie.
    await page.getByRole('button', { name: 'Saldo (S/)' }).click();
    await expect(page).toHaveURL(/sort=balance/);
    await expect(page.getByTestId('cxc-cliente').first()).toContainText('Drywall Norte');
    await expect(page.getByTestId('cxc-total')).toHaveText('6,200.50');
    await expect(total(page, 'tabla-cxc', 'current')).toHaveText('0.00');
    // El detalle: comprobante y pedido como enlaces.
    await page.getByRole('button', { name: 'Ver detalle de Drywall Norte' }).click();
    await expect(page.getByRole('link', { name: 'F001-00000202' })).toHaveAttribute(
      'href',
      `/comprobantes/${uuid(202)}`,
    );
    await expect(page.getByRole('link', { name: 'PED-E2E-302' })).toHaveAttribute(
      'href',
      `/pedidos/${uuid(302)}`,
    );

    await page.goto('/reportes/inventario-valorizado');
    await expect(page.getByTestId('grupo-bobinas')).toHaveCount(1);
    await expect(page.getByTestId('periodo')).toHaveCount(0);
    await expect(page).toHaveURL('/reportes/inventario-valorizado');
    await expect(total(page, 'tabla-inventario-bobinas', 'qty')).toHaveText('1,000.00');
    await expect(total(page, 'tabla-inventario-productos', 'value')).toHaveText('250.00');
    // El acabado con su nombre.
    await expect(page.getByTestId('grupo-bobinas')).toContainText('Rojo teja · RAL 3002 (AZR3002)');
  });

  test('Bobinas: el mes va en la URL y el Excel lo lleva', async ({ page }) => {
    const today = businessToday();
    const prev = previousMonth(today);
    await loginAsAdmin(page);
    await mockReports(page);

    await page.goto('/reportes/bobinas');
    await expect(page).toHaveURL(`/reportes/bobinas?mes=${today.slice(0, 7)}`);
    await expect(page.getByRole('button', { name: 'Este mes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Mes anterior' }).click();
    await expect(page).toHaveURL(`/reportes/bobinas?mes=${prev.month}`);
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
      'href',
      `/api/reports/coils/xlsx?month=${prev.month}&businessLine=metallic-roofing`,
    );
    const sealed = page.getByRole('region', { name: 'Bobinas selladas' });
    await expect(sealed).toContainText('Subtotal Selladas · 2 bobinas');
    await expect(total(page, 'tabla-selladas', 'closing')).toHaveText('3,500.00');
    await sealed.getByRole('button', { name: 'Saldo fin (kg)' }).click();
    await expect(page).toHaveURL(/selladasort=closing/);
    await expect(sealed.getByTestId('fila-bobina').first()).toContainText('BOB-E2E-002');

    // Un mes inválido: el error, sin esqueleto.
    await page.goto('/reportes/bobinas?mes=2026-13');
    await expect(page.getByText('El mes no es válido: revisa la fecha.')).toBeVisible();
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
  });

  test('Ventas por material: periodo único, total al pie y el diálogo del desglose', async ({
    page,
  }) => {
    const today = businessToday();
    await loginAsAdmin(page);
    await mockReports(page);

    await page.goto('/reportes/ventas-material');
    await expect(page).toHaveURL(
      `/reportes/ventas-material?from=${firstOfMonth(today)}&to=${today}`,
    );
    const rows = page.getByTestId('fila-material');
    await expect(rows).toHaveCount(2);
    await expect(total(page, 'ventas-material', 'sales')).toHaveText('4,500.50');
    await expect(page.getByRole('link', { name: 'Descargar Excel' })).toHaveAttribute(
      'href',
      `/api/reports/sales-by-material/xlsx?from=${firstOfMonth(today)}&to=${today}&businessLine=metallic-roofing`,
    );

    await page.getByRole('button', { name: 'Venta (S/)', exact: true }).click();
    await expect(rows.first()).toContainText('AZUL');

    // El diálogo se conserva: la fila lo abre.
    await rows.first().click();
    const dialog = page.getByTestId('desglose-material');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Coberturas 0.40 mm AZUL');
    await dialog.getByRole('button', { name: 'Ver comprobantes de BOB-E2E-002' }).click();
    await expect(dialog.getByRole('link', { name: 'F001-00000102' })).toHaveAttribute(
      'href',
      `/comprobantes/${uuid(102)}`,
    );
  });
});
