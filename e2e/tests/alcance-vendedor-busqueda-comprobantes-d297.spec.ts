import { expect, test } from '@playwright/test';
import { adminApi, createUser, getItems } from '../helpers/api';
import { apiAs } from '../helpers/production';
import {
  createInvoice,
  createInvoiceableCustomer,
  freeLine,
  purgeInvoicingTrail,
} from '../helpers/invoicing';

/**
 * D-297 — alcance del vendedor en la **búsqueda** de comprobantes.
 *
 * `GET /invoicing/documents?search=` asignaba el `OR` de la búsqueda sobre el `OR` del alcance
 * del vendedor y dejaba solo el último: un VENDEDOR que buscaba veía comprobantes de otros
 * vendedores. Con la búsqueda combinada por `AND`, A busca por el cliente o el documento de un
 * comprobante de B y recibe cero filas; el propio B y el administrador sí lo ven.
 *
 * Escribe (un comprobante en borrador): nunca contra producción (D-126).
 */
const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea un comprobante: nunca contra producción (D-126).');

test.describe('D-297 — la búsqueda de comprobantes respeta el alcance del vendedor', () => {
  test('A no encuentra por cliente ni por documento un comprobante de B; B y el admin sí', async ({
    baseURL,
  }) => {
    const admin = await adminApi(baseURL!);
    const vendorA = await createUser(admin, 'VENDEDOR');
    const vendorB = await createUser(admin, 'VENDEDOR');
    const contextA = await apiAs(baseURL!, vendorA);
    const contextB = await apiAs(baseURL!, vendorB);
    const trail: Parameters<typeof purgeInvoicingTrail>[1] = { documentIds: [] };
    try {
      const customer = await createInvoiceableCustomer(admin);
      const draft = await createInvoice(contextB, {
        docType: 'FACTURA',
        customerId: customer.id,
        items: [freeLine('1', '100.00')],
      });
      trail.documentIds = [draft.id];

      const ids = async (api: typeof admin, query: string): Promise<string[]> =>
        (await getItems<{ id: string }>(api, `/api/invoicing/documents?${query}`)).map((d) => d.id);
      const byName = `search=${encodeURIComponent(customer.name)}`;
      const byDoc = `search=${encodeURIComponent(customer.docNumber)}`;

      // A: sin búsqueda no ve el de B, y con búsqueda (por cliente o por documento) tampoco.
      expect(await ids(contextA, ''), 'A no debe ver el comprobante de B').not.toContain(draft.id);
      expect(await ids(contextA, byName), 'A buscó por el nombre del cliente de B').toEqual([]);
      expect(await ids(contextA, byDoc), 'A buscó por el documento del cliente de B').toEqual([]);

      // B: es suyo, con y sin búsqueda.
      expect(await ids(contextB, byName)).toContain(draft.id);
      expect(await ids(contextB, byDoc)).toContain(draft.id);

      // El administrador lo ve por cualquiera de las dos vías.
      expect(await ids(admin, byName)).toContain(draft.id);
      expect(await ids(admin, byDoc)).toContain(draft.id);
    } finally {
      await purgeInvoicingTrail(admin, trail);
      await contextA.dispose();
      await contextB.dispose();
      await admin.dispose();
    }
  });
});
