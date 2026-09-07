import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, createUser, getJson, postJson } from '../helpers/api';
import { apiAs, postExpectingError, today, uniqueDocumentNumber } from '../helpers/production';
import { createCustomer, patchExpectingError } from '../helpers/sales';
import { createInvoice, freeLine, invoiceBody, type FiscalDocumentDto } from '../helpers/invoicing';
import { loginAndSetPassword } from '../helpers/ui';

/**
 * Sesión 7-final, milestone M0 — dos arreglos puntuales:
 *
 * - **M0a** (D-132): el índice único de comprobante de compra ahora es parcial
 *   (`WHERE status <> 'CANCELLED'`): una compra anulada libera su número, y solo chocan
 *   dos compras **vivas**. `PATCH /purchases/:id/document` corrige serie/número de una
 *   compra viva (dato de cáscara, solo ADMINISTRADOR).
 * - **M0b** (D-133): `OperationDateService.assertIssueDate` — un VENDEDOR solo emite
 *   comprobantes con fecha de hoy; retrofechar la emisión es privilegio de ADMINISTRADOR,
 *   dentro de la misma ventana de SUNAT que ya validaba el schema.
 *
 * Todos los escenarios escriben (compras, comprobantes): nunca contra producción
 * (regla dura 9, D-126). Esta suite corre contra la rama Neon `ci`, igual que `pnpm e2e`.
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'M0 crea y anula compras y comprobantes: nunca contra producción (D-126, regla dura 9).',
);

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';

interface PurchaseDto {
  id: string;
  supplierId: string;
  docType: string;
  series: string;
  number: string;
  documentLabel: string;
  status: string;
}

/** Cuerpo mínimo de una compra de servicio: no crea bobinas ni exige acabado. */
function servicePurchaseBody(input: {
  supplierId: string;
  series?: string;
  number?: string;
  docType?: 'FACTURA' | 'BOLETA';
}): Record<string, unknown> {
  return {
    supplierId: input.supplierId,
    businessLine: 'services',
    type: 'SERVICE',
    docType: input.docType ?? 'FACTURA',
    series: input.series ?? 'F001',
    number: input.number ?? uniqueDocumentNumber(),
    issueDate: today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    serviceKind: 'FREIGHT',
    items: [{ description: 'Flete de prueba E2E', qty: '1', unit: 'ZZ', unitPrice: '100' }],
  };
}

async function createServicePurchase(
  api: APIRequestContext,
  input: Parameters<typeof servicePurchaseBody>[0],
): Promise<PurchaseDto> {
  return postJson<PurchaseDto>(api, '/api/purchases', servicePurchaseBody(input));
}

async function cancelPurchases(api: APIRequestContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    await api
      .post(`/api/purchases/${id}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
      .catch(() => undefined);
  }
}

async function deactivateSuppliers(api: APIRequestContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    await api.patch(`/api/suppliers/${id}`, { data: { isActive: false } }).catch(() => undefined);
  }
}

const CONFLICT_MESSAGE =
  'Ese comprobante ya está registrado para este proveedor en una compra vigente';

test.describe('M0a — unicidad de comprobante de compra solo entre compras vivas (D-132)', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test('caso 1: anular una compra libera su comprobante y se puede volver a registrar', async () => {
    const supplier = await createSupplier(api);
    const series = 'F001';
    const number = uniqueDocumentNumber();
    const purchaseIds: string[] = [];
    try {
      const first = await createServicePurchase(api, { supplierId: supplier.id, series, number });
      purchaseIds.push(first.id);

      await postJson(api, `/api/purchases/${first.id}/cancel`, {
        reason: 'Anulación de prueba E2E',
      });

      const second = await createServicePurchase(api, { supplierId: supplier.id, series, number });
      purchaseIds.push(second.id);
      expect(second.series).toBe(series);
      expect(second.number).toBe(number);
      expect(second.status).not.toBe('CANCELLED');
    } finally {
      await cancelPurchases(api, purchaseIds);
      await deactivateSuppliers(api, [supplier.id]);
    }
  });

  test('caso 2: dos compras vivas del mismo proveedor con el mismo comprobante chocan (409)', async () => {
    const supplier = await createSupplier(api);
    const series = 'F001';
    const number = uniqueDocumentNumber();
    const purchaseIds: string[] = [];
    try {
      const first = await createServicePurchase(api, { supplierId: supplier.id, series, number });
      purchaseIds.push(first.id);

      const error = await postExpectingError(
        api,
        '/api/purchases',
        servicePurchaseBody({ supplierId: supplier.id, series, number }),
      );
      expect(error.status).toBe(409);
      expect(error.message).toBe(CONFLICT_MESSAGE);
    } finally {
      await cancelPurchases(api, purchaseIds);
      await deactivateSuppliers(api, [supplier.id]);
    }
  });

  test('caso 3: el mismo comprobante en dos proveedores distintos no choca', async () => {
    const supplierA = await createSupplier(api);
    const supplierB = await createSupplier(api);
    const series = 'F001';
    const number = uniqueDocumentNumber();
    const purchaseIds: string[] = [];
    try {
      const first = await createServicePurchase(api, { supplierId: supplierA.id, series, number });
      purchaseIds.push(first.id);

      const second = await createServicePurchase(api, { supplierId: supplierB.id, series, number });
      purchaseIds.push(second.id);
      expect(second.series).toBe(series);
      expect(second.number).toBe(number);
    } finally {
      await cancelPurchases(api, purchaseIds);
      await deactivateSuppliers(api, [supplierA.id, supplierB.id]);
    }
  });

  test('caso 4a: PATCH .../document corrige el número de una compra viva y el detalle lo muestra', async ({
    page,
  }) => {
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const supplier = await createSupplier(api);
    const originalNumber = uniqueDocumentNumber();
    const purchase = await createServicePurchase(api, {
      supplierId: supplier.id,
      series: 'F001',
      number: originalNumber,
    });
    const purchaseIds = [purchase.id];
    try {
      const newSeries = 'F002';
      const newNumber = uniqueDocumentNumber();

      await page.goto(`/compras/${purchase.id}`);
      await expect(
        page.getByRole('heading', { name: `Factura F001-${originalNumber}` }),
      ).toBeVisible();

      await page.getByRole('button', { name: 'Corregir número' }).click();
      // `exact: true`: sin él, "Número" también matchea (por substring, case-insensitive)
      // el título del diálogo "Corregir el número del comprobante", que Playwright expone
      // como accesible vía `aria-labelledby` del propio `role=dialog` — violación de modo
      // estricto, no ambigüedad real del formulario.
      await page.getByLabel('Serie', { exact: true }).fill(newSeries);
      await page.getByLabel('Número', { exact: true }).fill(newNumber);
      await page.getByRole('button', { name: 'Guardar' }).click();

      await expect(page.getByText('Número de comprobante corregido')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: `Factura ${newSeries}-${newNumber}` }),
      ).toBeVisible();

      const reloaded = await getJson<PurchaseDto>(api, `/api/purchases/${purchase.id}`);
      expect(reloaded.series).toBe(newSeries);
      expect(reloaded.number).toBe(newNumber);
    } finally {
      await cancelPurchases(api, purchaseIds);
      await deactivateSuppliers(api, [supplier.id]);
    }
  });

  test('caso 4b: PATCH .../document rechaza el número si choca con otra compra viva (409)', async () => {
    const supplier = await createSupplier(api);
    const number1 = uniqueDocumentNumber();
    const purchaseIds: string[] = [];
    try {
      const purchase1 = await createServicePurchase(api, {
        supplierId: supplier.id,
        series: 'F001',
        number: number1,
      });
      purchaseIds.push(purchase1.id);
      // `number2` se calcula recién acá, después del `await` de arriba: `uniqueDocumentNumber`
      // sale de `Date.now()`, y dos llamadas sin ningún await entre medio pueden caer en el
      // mismo milisegundo y devolver el mismo número — que es exactamente lo que el caso 2 ya
      // prueba a propósito, pero acá sería un choque accidental contra el propio setup.
      const number2 = uniqueDocumentNumber();
      const purchase2 = await createServicePurchase(api, {
        supplierId: supplier.id,
        series: 'F001',
        number: number2,
      });
      purchaseIds.push(purchase2.id);

      const error = await patchExpectingError(api, `/api/purchases/${purchase1.id}/document`, {
        series: 'F001',
        number: number2,
      });
      expect(error.status).toBe(409);
      expect(error.message).toBe(CONFLICT_MESSAGE);

      // Nada cambió: purchase1 sigue con su número original.
      const stillOriginal = await getJson<PurchaseDto>(api, `/api/purchases/${purchase1.id}`);
      expect(stillOriginal.number).toBe(number1);
    } finally {
      await cancelPurchases(api, purchaseIds);
      await deactivateSuppliers(api, [supplier.id]);
    }
  });
});

// ---------------------------------------------------------------------------
// M0b — fecha de emisión: VENDEDOR solo hoy, retrofecha de ADMINISTRADOR (D-133)
// ---------------------------------------------------------------------------

/**
 * Ayer, en Lima, sin `toISOString().slice(0, 10)` (lección D-112/D-131): se arma a partir
 * de `today()` (que ya está en Lima) y se resta un día a mediodía UTC, donde el desfase de
 * cinco horas de Lima nunca cruza el borde del día.
 */
function yesterday(): string {
  const [year, month, day] = today().split('-').map(Number);
  const noonUtc = new Date(Date.UTC(year!, month! - 1, day!, 12, 0, 0));
  noonUtc.setUTCDate(noonUtc.getUTCDate() - 1);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(noonUtc);
}

test.describe('M0b — fecha de emisión: VENDEDOR solo hoy, retrofecha de ADMINISTRADOR (D-133)', () => {
  let api: APIRequestContext;
  let customerId: string;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    const customer = await createCustomer(api);
    customerId = customer.id;
  });

  test('caso 5: un VENDEDOR no puede emitir un comprobante fechado ayer (403)', async ({
    baseURL,
  }) => {
    const seller = await createUser(api, 'VENDEDOR');
    const sellerApi = await apiAs(baseURL!, seller);
    try {
      const error = await postExpectingError(
        sellerApi,
        '/api/invoicing/documents',
        invoiceBody({
          docType: 'BOLETA',
          customerId,
          issueDate: yesterday(),
          items: [freeLine('1', '50.00')],
        }),
      );
      expect(error.status).toBe(403);
      expect(error.message).toContain(
        'Solo un administrador puede emitir con una fecha distinta de hoy',
      );
    } finally {
      await sellerApi.dispose();
    }
  });

  test('caso 6: un VENDEDOR sí puede emitir un comprobante fechado hoy', async ({ baseURL }) => {
    const seller = await createUser(api, 'VENDEDOR');
    const sellerApi = await apiAs(baseURL!, seller);
    try {
      const draft: FiscalDocumentDto = await createInvoice(sellerApi, {
        docType: 'BOLETA',
        customerId,
        issueDate: today(),
        items: [freeLine('1', '50.00')],
      });
      expect(draft.status).toBe('DRAFT');
      expect(draft.issueDate.slice(0, 10)).toBe(today());
    } finally {
      await sellerApi.dispose();
    }
  });

  test('caso 7: un ADMINISTRADOR sí puede retrofechar la emisión a ayer', async () => {
    const draft: FiscalDocumentDto = await createInvoice(api, {
      docType: 'BOLETA',
      customerId,
      issueDate: yesterday(),
      items: [freeLine('1', '50.00')],
    });
    expect(draft.status).toBe('DRAFT');
    expect(draft.issueDate.slice(0, 10)).toBe(yesterday());
  });
});
