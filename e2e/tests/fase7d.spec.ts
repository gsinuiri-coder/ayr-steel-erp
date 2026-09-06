import { expect, test } from '@playwright/test';
import {
  adminApi,
  createFinish,
  createSupplier,
  createUser,
  getItems,
  postJson,
} from '../helpers/api';
import { deactivateTrail, today, uniqueDocumentNumber } from '../helpers/production';
import { loginAndSetPassword, selectOption } from '../helpers/ui';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Fase 7d — pulido pre-entrega: paginación server-side (D-113) en los listados que antes
 * devolvían un array plano, y la corrección del corte UTC en las pantallas que muestran
 * `createdAt`/`sentAt`. Todos los escenarios escriben, así que contra producción solo
 * corren si se piden de forma explícita (D-024), igual que el resto de fases.
 *
 * Cleanup: igual que Fase 2a/2b, solo se deshace lo creado cuando corre contra producción
 * (`isProduction`); en local la base `dev` se repone reseteando (`pnpm db:reset-dev`), no
 * borrando a mano desde el test.
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';

interface CreatedPurchase {
  id: string;
}

interface CreatedCoil {
  id: string;
  code: string;
  createdAt: string;
}

test.describe('Fase 7d — paginación server-side y fechas en zona de Lima', () => {
  test.skip(skipWrites, 'Crea datos: en producción solo con pnpm e2e:prod');

  test('la lista de clientes pagina server-side: "Siguiente" avanza de página (RF-80, D-113)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    // Token único en el nombre: filtra exactamente estos 26 clientes en la búsqueda del
    // servidor, sin importar cuántos otros haya acumulados en la base `dev` de correr la
    // suite local muchas veces — si no se aísla, el número de páginas depende de la
    // historia de la base y el test deja de ser determinista.
    const token = `PAG${Date.now().toString(36).toUpperCase()}`;
    const base = String(Date.now()).slice(-6);
    // En paralelo: 26 altas en serie se acercan al timeout del test (45 s) contra Neon.
    const createdCustomers = await Promise.all(
      Array.from({ length: 26 }, (_, i) =>
        postJson<{ id: string }>(api, '/api/customers', {
          docType: 'RUC',
          docNumber: `20${base}${String(i).padStart(3, '0')}`,
          name: `E2E Cliente ${token} ${i}`,
          address: 'Av. Prueba 123, Lima',
          creditDays: 0,
        }),
      ),
    );

    try {
      await page.goto('/clientes');
      await expect(page.getByRole('heading', { name: 'Clientes' })).toBeVisible();
      await page.getByPlaceholder('Buscar por nombre o número de documento…').fill(token);

      // 26 filas no caben en el tamaño por defecto (50): bajar a 25 fuerza una segunda página.
      await selectOption(page, page.getByRole('combobox', { name: 'Filas por página' }), '25');

      await expect(page.getByText('Página 1 de 2')).toBeVisible();
      const firstPageRow = await page.getByRole('row').nth(1).textContent();

      await page.getByRole('button', { name: 'Siguiente' }).click();
      await expect(page.getByText('Página 2 de 2')).toBeVisible();
      const secondPageRow = await page.getByRole('row').nth(1).textContent();
      expect(secondPageRow).not.toBe(firstPageRow);

      // "Anterior" tiene que volver a la primera página con las mismas filas de antes.
      await page.getByRole('button', { name: 'Anterior' }).click();
      await expect(page.getByText('Página 1 de 2')).toBeVisible();
    } finally {
      if (isProduction) {
        await deactivateTrail(api, { customerIds: createdCustomers.map((c) => c.id) });
      }
    }
  });

  test('la lista de compras pagina server-side: "Siguiente" avanza de página (D-030, D-113)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const supplier = await createSupplier(api);
    const base = String(Date.now()).slice(-6);
    const issueDate = today();
    // En paralelo, por la misma razón que en la lista de clientes.
    await Promise.all(
      Array.from({ length: 26 }, (_, i) =>
        postJson<CreatedPurchase>(api, '/api/purchases', {
          supplierId: supplier.id,
          businessLine: 'drywall',
          type: 'EXPENSE',
          docType: 'FACTURA',
          series: 'F001',
          number: `${base}${String(i).padStart(3, '0')}`,
          issueDate,
          currency: 'PEN',
          igvRate: '18',
          paymentTerms: 'CONTADO',
          items: [
            { description: `Gasto E2E paginación ${i}`, qty: '1', unit: 'ZZ', unitPrice: '10' },
          ],
        }),
      ),
    );

    try {
      await page.goto('/compras');
      await expect(page.getByRole('heading', { name: 'Compras' })).toBeVisible();
      // El buscador filtra por proveedor: el nombre del proveedor recién creado (código al
      // azar) aísla exactamente estas 26 compras del resto de la base.
      await page.getByLabel('Buscar compras').fill(supplier.name);

      await selectOption(page, page.getByRole('combobox', { name: 'Filas por página' }), '25');

      await expect(page.getByText('Página 1 de 2')).toBeVisible();
      const firstPageRow = await page.getByRole('row').nth(1).textContent();

      await page.getByRole('button', { name: 'Siguiente' }).click();
      await expect(page.getByText('Página 2 de 2')).toBeVisible();
      const secondPageRow = await page.getByRole('row').nth(1).textContent();
      expect(secondPageRow).not.toBe(firstPageRow);
    } finally {
      if (isProduction) {
        await deactivateTrail(api, { supplierId: supplier.id });
      }
    }
  });

  test('la fecha de alta de una bobina se muestra en el día de Lima, no en UTC (Fase 7d)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const supplier = await createSupplier(api);
    const finish = await createFinish(api);

    const purchase = await postJson<CreatedPurchase>(api, '/api/purchases', {
      supplierId: supplier.id,
      businessLine: 'trading',
      type: 'COIL',
      docType: 'FACTURA',
      series: 'F001',
      number: uniqueDocumentNumber(),
      issueDate: today(),
      currency: 'PEN',
      igvRate: '18',
      paymentTerms: 'CONTADO',
      items: [
        {
          description: 'Bobina E2E fecha Lima',
          qty: '1000',
          unit: 'KGM',
          unitPrice: '4',
          finishId: finish.id,
          widthMm: '1200',
          thicknessMm: '2',
        },
      ],
    });

    try {
      await postJson<CreatedPurchase>(api, `/api/purchases/${purchase.id}/receive`);
      const coils = await getItems<CreatedCoil>(api, `/api/coils?supplierId=${supplier.id}`);
      const coil = coils[0]!;

      // No se puede fijar `createdAt` a mano: lo pone el servidor con `now()` al crear la
      // bobina, y este proyecto no toca la base directo con Prisma desde un E2E (todos
      // hablan HTTP o UI). Tampoco sirve mockear el reloj del navegador: el timestamp ya
      // quedó fijado en el servidor antes de que la página cargue. Por eso el test recalcula
      // acá, con el mismo criterio que `formatTimestampDate` (America/Lima, sin horario de
      // verano —Perú no lo tiene—, así que la cuenta es estable sin importar la hora real de
      // la corrida), la fecha que la UI debería mostrar, y la compara contra lo que muestra.
      // Con el defecto viejo (`slice(0,10)` sobre el ISO en UTC) esto habría fallado cada vez
      // que la suite corriera entre las 19:00 y las 23:59 hora Lima.
      const limaDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Lima',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(coil.createdAt));
      const [y, m, d] = limaDay.split('-');
      const expectedAlta = `${d}/${m}/${y}`;

      await page.goto(`/bobinas/${coil.id}`);
      await expect(page.getByRole('heading', { name: coil.code })).toBeVisible();
      await expect(page.getByText('Alta', { exact: true })).toBeVisible();
      await expect(page.getByText(expectedAlta)).toBeVisible();
    } finally {
      if (isProduction) {
        await deactivateTrail(api, { supplierId: supplier.id, finish });
      }
    }
  });
});
