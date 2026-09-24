import { spawnSync } from 'node:child_process';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminApi, createSupplier, getJson, postJson } from '../helpers/api';
import { insertLegacyCoilProduct, setProductSkuForTest } from '../helpers/db';
import {
  createInvoice,
  createInvoiceableCustomer,
  DISPATCH_LINE,
  dispatchOrder,
  type FiscalDocumentDto,
} from '../helpers/invoicing';
import { today, type ProductDto } from '../helpers/production';
import { buyRoofingCoil, createColor, createRoofingFinish } from '../helpers/roofing';
import { createDirectOrder } from '../helpers/sales';

/**
 * **RF-S4b/M1 — la normalización de SKU de bobina no mueve un solo sol de los reportes.**
 *
 * Reproduce el estado de producción antes de la ventana: el producto de venta de un tipo de
 * bobina con el SKU viejo (`BOB{acabado}0.38`, D-037) y ya vendido, más un `BOB38<color>` suelto
 * cargado a mano. La normalización tiene que renombrar el vendido al canónico (es el principal:
 * es el que tiene movimientos), unirle el suelto —que queda inactivo con su código viejo y
 * `mergedInto`— y dejar el inventario valorizado y el reporte de margen (RF-S4a) exactamente
 * iguales: la historia sigue apuntando a los mismos ids y las bobinas no se tocan.
 *
 * Corre la CLI real (`pnpm normalize:coil-skus --branch local-e2e`), con el mismo servicio de
 * dominio que la ventana va a correr contra producción. Nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Escribe catálogo, compras y ventas: nunca contra producción (D-126).');
test.describe.configure({ timeout: 480_000 });

interface ValuationDto {
  totals: { coilValuePen: string; productValuePen: string; totalValuePen: string };
}
interface MarginDto {
  totals: { salesPen: string; costPen: string; marginPen: string };
}
interface NormalizationGroupDto {
  canonicalSku: string;
  principal: { id: string; sku: string; uses: number };
  renamePrincipal: boolean;
  merged: { id: string; sku: string }[];
  kg: string;
}
interface NormalizationPlanDto {
  renames: NormalizationGroupDto[];
  merges: NormalizationGroupDto[];
  stops: string[];
  kg: { total: string; after: string };
}

interface RevertPlanDto {
  runId: string | null;
  steps: (
    | { kind: 'RENAME'; productId: string; fromSku: string; toSku: string }
    | { kind: 'UNMERGE'; productId: string; sku: string; mergedIntoId: string }
  )[];
  stops: string[];
}

function normalize(args: string[]): unknown {
  const res = spawnSync(
    'node',
    ['scripts/normalize-coil-skus.mjs', '--branch', 'local-e2e', '--json', ...args],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 300_000 },
  );
  expect(res.status, `la normalización falló:\n${res.stderr}`).toBe(0);
  const line = res.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line);
}

test.describe('RF-S4b — normalización de SKU de bobina', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('renombra el vendido, une el suelto y los reportes de inventario y margen no cambian', async ({
    baseURL,
  }) => {
    const color = await createColor(api, '#123456');
    const finish = await createRoofingFinish(api, { colorId: color.id });
    const supplier = await createSupplier(api, { name: 'E2E Proveedor RF-S4b normalización' });
    const buy = (weightKg: string) =>
      buyRoofingCoil(api, {
        supplierId: supplier.id,
        finishId: finish.id,
        colorId: color.id,
        lineCode: DISPATCH_LINE,
        weightKg,
        thicknessMm: '0.38',
        widthMm: '1200',
        unitPrice: '2',
      });
    const sold = await buy('500');
    // La que queda: el pool conserva kilos, así que el cuadre de kilos tiene de qué hablar.
    await buy('2000');

    const canonical = `BOB038${color.code}`;
    const catalog = await getJson<ProductDto[]>(api, '/api/catalog');
    const product = catalog.find((p) => p.sku === canonical);
    expect(product, 'el alta de la bobina no creó el producto canónico').toBeDefined();
    // El estado de producción antes de la ventana: el SKU viejo de D-037…
    const coilFinish = await getJson<{ code: string }>(api, `/api/finishes/${sold.coil.finishId}`);
    const legacySku = `BOB${coilFinish.code.toUpperCase()}0.38`;
    await setProductSkuForTest(product!.id, legacySku);
    // …y un suelto cargado a mano con el código del origen.
    const looseId = await insertLegacyCoilProduct(`BOB38${color.code}`, `Suelto ${color.code}`);

    // Una venta real sobre el producto viejo: despacho (costo) y comprobante manual (venta).
    const customer = await createInvoiceableCustomer(api);
    const order = await createDirectOrder(api, {
      customerId: customer.id,
      businessLine: DISPATCH_LINE,
      items: [{ saleCoilId: sold.coil.id, qty: '500.000', unitPricePen: '9.0000' }],
    });
    expect(order.items[0]!.productSku).toBe(legacySku);
    await dispatchOrder(api, {
      salesOrderId: order.id,
      items: [{ salesOrderItemId: order.items[0]!.id, qty: '500.000', weightKg: '500.000' }],
    });
    const draft = await createInvoice(api, {
      docType: 'FACTURA',
      customerId: customer.id,
      salesOrderId: order.id,
      items: [{ salesOrderItemId: order.items[0]!.id, qty: '500.000' }],
    });
    await postJson<FiscalDocumentDto>(api, `/api/invoicing/documents/${draft.id}/register-manual`, {
      series: `F9${String(Math.floor(Math.random() * 90) + 10)}`,
      correlative: Math.floor(Math.random() * 90_000) + 1_000,
    });

    const day = today();
    const valuationBefore = await getJson<ValuationDto>(api, '/api/reports/inventory-valuation');
    const marginBefore = await getJson<MarginDto>(
      api,
      `/api/reports/sales-margin?from=${day}&to=${day}`,
    );

    // --- Dry-run: el plan dice lo que va a hacer, sin paradas ---
    const plan = normalize([]) as NormalizationPlanDto;
    expect(plan.stops).toEqual([]);
    const group = plan.merges.find((g) => g.canonicalSku === canonical);
    expect(group, `el dry-run no agrupó ${canonical}`).toBeDefined();
    expect(group!.principal.sku).toBe(legacySku);
    expect(group!.renamePrincipal).toBe(true);
    expect(group!.merged.map((m) => m.sku)).toEqual([`BOB38${color.code}`]);
    expect(group!.kg).toBe('2000.000');
    expect(plan.kg.after).toBe(plan.kg.total);

    // --- Execute ---
    normalize(['--execute', '--ack-open-documents']);
    // Contexto nuevo: el anterior quedó ocioso mientras la CLI compilaba y corría, y su socket
    // keep-alive puede estar cerrado (mismo motivo que en el spec de COT-000002).
    await api.dispose();
    api = await adminApi(baseURL!);

    // El principal conserva su id —la historia apunta ahí— y ahora se llama como el canónico.
    const principal = await getJson<ProductDto & { isActive: boolean }>(
      api,
      `/api/catalog/${product!.id}`,
    );
    expect(principal.sku).toBe(canonical);
    expect(principal.isActive).toBe(true);
    // El suelto no se borra: inactivo, con su código viejo.
    const loose = await getJson<ProductDto & { isActive: boolean }>(api, `/api/catalog/${looseId}`);
    expect(loose.sku).toBe(`BOB38${color.code}`);
    expect(loose.isActive).toBe(false);

    // Los reportes de RF-S4a, al centavo.
    const valuationAfter = await getJson<ValuationDto>(api, '/api/reports/inventory-valuation');
    const marginAfter = await getJson<MarginDto>(
      api,
      `/api/reports/sales-margin?from=${day}&to=${day}`,
    );
    expect(valuationAfter.totals).toEqual(valuationBefore.totals);
    expect(marginAfter.totals).toEqual(marginBefore.totals);

    // Y el pedido histórico sigue apuntando al mismo producto, ya con el nombre canónico.
    const orderAfter = await getJson<{ items: { productId: string; productSku: string }[] }>(
      api,
      `/api/sales/orders/${order.id}`,
    );
    expect(orderAfter.items[0]).toMatchObject({ productId: product!.id, productSku: canonical });

    // Un segundo dry-run ya no tiene nada que hacer con este grupo.
    const again = normalize([]) as NormalizationPlanDto;
    expect(again.merges.find((g) => g.canonicalSku === canonical)).toBeUndefined();
    expect(again.renames.find((g) => g.canonicalSku === canonical)).toBeUndefined();

    // --- Revisión cruzada RF-S4b (P1-4): la vuelta atrás, desde la auditoría ---
    // Dry-run: la reversa nombra exactamente lo que la corrida hizo con este grupo.
    const revertPlan = normalize(['--revert']) as RevertPlanDto;
    expect(revertPlan.stops).toEqual([]);
    expect(revertPlan.steps).toEqual(
      expect.arrayContaining([
        { kind: 'RENAME', productId: product!.id, fromSku: canonical, toSku: legacySku },
        {
          kind: 'UNMERGE',
          productId: looseId,
          sku: `BOB38${color.code}`,
          mergedIntoId: product!.id,
        },
      ]),
    );
    normalize(['--revert', '--execute']);
    await api.dispose();
    api = await adminApi(baseURL!);

    // El estado final es el inicial: el SKU viejo en el vendido y el suelto activo otra vez.
    const principalBack = await getJson<ProductDto & { isActive: boolean }>(
      api,
      `/api/catalog/${product!.id}`,
    );
    expect(principalBack.sku).toBe(legacySku);
    expect(principalBack.isActive).toBe(true);
    const looseBack = await getJson<ProductDto & { isActive: boolean }>(
      api,
      `/api/catalog/${looseId}`,
    );
    expect(looseBack.sku).toBe(`BOB38${color.code}`);
    expect(looseBack.isActive).toBe(true);
    // Los reportes de RF-S4a, iguales otra vez.
    expect((await getJson<ValuationDto>(api, '/api/reports/inventory-valuation')).totals).toEqual(
      valuationBefore.totals,
    );
    expect(
      (await getJson<MarginDto>(api, `/api/reports/sales-margin?from=${day}&to=${day}`)).totals,
    ).toEqual(marginBefore.totals);
    // Deshecha, no queda nada por deshacer de esa corrida; y la normalización se puede repetir.
    const replan = normalize([]) as NormalizationPlanDto;
    expect(replan.merges.find((g) => g.canonicalSku === canonical)).toBeDefined();
    normalize(['--execute', '--ack-open-documents']);
    await api.dispose();
    api = await adminApi(baseURL!);
    const principalAgain = await getJson<ProductDto>(api, `/api/catalog/${product!.id}`);
    expect(principalAgain.sku).toBe(canonical);
  });
});
