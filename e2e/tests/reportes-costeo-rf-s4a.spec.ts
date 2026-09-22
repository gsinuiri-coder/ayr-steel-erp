import { test, expect, type APIRequestContext } from '@playwright/test';
import { businessToday } from '@ayr/shared';
import { adminApi, createUser, getJson } from '../helpers/api';
import { apiAs } from '../helpers/production';
import { setupCoilStock } from '../helpers/sales';
import {
  createAndSend,
  dispatchOrder,
  expectNotRejected,
  probePse,
  setupOrderScenario,
} from '../helpers/invoicing';

/**
 * RF-S4a — los dos reportes de costeo.
 *
 * Los dos llevan costos en cada fila, así que son **solo ADMINISTRADOR** y no enmascaran: la
 * ruta se cierra entera en vez de vaciar columnas. Eso es lo primero que se prueba, porque es
 * lo que un cambio de menú o de guard rompe sin que nadie lo note.
 *
 * Después se prueba que los números salgan de donde tienen que salir, con una venta real
 * hecha en la misma corrida: una bobina comprada, vendida entera (D-116), despachada y
 * facturada. La bobina es el caso más limpio para esto porque su costo de venta no pasa por
 * producción, así que el costo que el reporte muestra tiene que ser exactamente el valor que
 * el despacho sacó del kardex.
 */

interface ValuationReport {
  asOf: string;
  coilGroups: {
    key: string;
    businessLine: string;
    thicknessMm: string;
    colorName: string | null;
    coilCount: number;
    qtyKg: string;
    avgCostPen: string;
    totalValuePen: string;
    coils: {
      id: string;
      code: string;
      qtyKg: string;
      avgCostPen: string;
      totalValuePen: string;
      status: string;
    }[];
  }[];
  products: { itemId: string; sku: string; qty: string; totalValuePen: string }[];
  totalsByLine: { businessLine: string; totalValuePen: string }[];
  totals: { coilValuePen: string; productValuePen: string; totalValuePen: string };
}

interface MarginReport {
  from: string;
  to: string;
  orders: {
    salesOrderId: string | null;
    orderCode: string | null;
    salesPen: string;
    costPen: string | null;
    opMaterialCostPen: string;
    marginPen: string | null;
    marginPct: string | null;
    costStatus: 'COMPLETO' | 'PARCIAL' | 'NO_COMPARABLE';
    inTotals: boolean;
    documents: { id: string; number: string | null; salesPen: string; costPen: string | null }[];
  }[];
  totalsByLine: { businessLine: string | null; salesPen: string; costPen: string }[];
  totals: {
    salesPen: string;
    costPen: string;
    marginPen: string;
    marginPct: string | null;
    partialOrderCount: number;
    excludedOrderCount: number;
    excludedSalesPen: string;
  };
}

function valuation(api: APIRequestContext): Promise<ValuationReport> {
  return getJson<ValuationReport>(api, '/api/reports/inventory-valuation');
}

function margin(api: APIRequestContext, from: string, to: string): Promise<MarginReport> {
  return getJson<MarginReport>(api, `/api/reports/sales-margin?from=${from}&to=${to}`);
}

const sum = (values: string[]): number =>
  Number(values.reduce((acc, v) => acc + Number(v), 0).toFixed(4));

test.describe('RF-S4a — reportes de costeo', () => {
  test('solo el administrador entra; vendedor y supervisor reciben 403', async ({
    baseURL,
    playwright: _playwright,
  }) => {
    const admin = await adminApi(baseURL!);
    const vendedor = await apiAs(baseURL!, await createUser(admin, 'VENDEDOR'));
    const supervisor = await apiAs(baseURL!, await createUser(admin, 'SUPERVISOR_PLANTA'));

    const today = businessToday();
    const routes = [
      '/api/reports/inventory-valuation',
      `/api/reports/sales-margin?from=${today}&to=${today}`,
    ];

    for (const route of routes) {
      const asAdmin = await admin.get(route);
      expect(asAdmin.status(), `el administrador tiene que poder leer ${route}`).toBe(200);

      // 403 y no 404: acá no se esconde la existencia de nada, se niega el permiso. El 404 de
      // S3c (D-238) es otra cosa — oculta entidades ajenas a un vendedor, no rutas enteras.
      const asVendedor = await vendedor.get(route);
      expect(asVendedor.status(), `un vendedor no puede leer ${route}`).toBe(403);

      const asSupervisor = await supervisor.get(route);
      expect(asSupervisor.status(), `un supervisor de planta no puede leer ${route}`).toBe(403);
    }

    await vendedor.dispose();
    await supervisor.dispose();
  });

  test('M1: la bobina comprada aparece valorizada y los totales cierran contra las filas', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    // Bobina suelta y sin reservar: su saldo de kardex es su peso entero, así que el valor
    // esperado se puede escribir a mano en vez de leerlo del mismo reporte que se prueba.
    const stock = await setupCoilStock(api, {
      lineCode: 'drywall',
      weightKg: '800',
      unitPrice: '5',
    });

    const report = await valuation(api);

    expect(report.asOf).toBe(businessToday());

    const group = report.coilGroups.find((g) => g.coils.some((c) => c.id === stock.coil.id));
    expect(group, 'la bobina recién comprada tiene que estar en algún grupo').toBeDefined();

    const coil = group!.coils.find((c) => c.id === stock.coil.id)!;
    expect(coil.code).toBe(stock.coil.code);
    expect(coil.status).toBe('OPEN');
    expect(Number(coil.qtyKg)).toBeCloseTo(800, 3);
    // 800 kg a 5 S/ el kilo. El costo que entra al kardex es el subtotal, **sin IGV**
    // (D-038): si alguna vez entra con IGV, este número pasa a 4720 y el test lo dice.
    expect(Number(coil.totalValuePen)).toBeCloseTo(4000, 2);
    expect(Number(coil.avgCostPen ?? '0')).toBeCloseTo(5, 4);

    // El total general es la suma de los totales por línea, y estos la de sus grupos: que el
    // redondeo no se haga en el nivel equivocado es justamente lo que se está verificando.
    expect(Number(report.totals.totalValuePen)).toBeCloseTo(
      sum(report.totalsByLine.map((t) => t.totalValuePen)),
      2,
    );
    expect(Number(report.totals.coilValuePen)).toBeCloseTo(
      sum(report.coilGroups.map((g) => g.totalValuePen)),
      2,
    );
    expect(Number(report.totals.productValuePen)).toBeCloseTo(
      sum(report.products.map((p) => p.totalValuePen)),
      2,
    );
  });

  test('M2: la venta facturada trae su costo desde el movimiento de salida del despacho', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const pse = await probePse(api);
    const scenario = await setupOrderScenario(api, { coilKg: '500', unitPricePen: '9.0000' });

    const valuationBefore = await valuation(api);
    const coilValueBefore = Number(
      valuationBefore.coilGroups.flatMap((g) => g.coils).find((c) => c.id === scenario.coil.id)
        ?.totalValuePen ?? '0',
    );
    expect(coilValueBefore, 'la bobina tiene que valer algo antes de venderse').toBeGreaterThan(0);

    await dispatchOrder(api, {
      salesOrderId: scenario.order.id,
      items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
    });

    const invoice = await createAndSend(api, {
      docType: 'FACTURA',
      customerId: scenario.customer.id,
      salesOrderId: scenario.order.id,
      items: [{ salesOrderItemId: scenario.item.id, qty: scenario.item.qty }],
    });
    expectNotRejected(invoice, 'la factura del reporte', pse);

    const today = businessToday();
    const report = await margin(api, today, today);

    const row = report.orders.find((o) => o.salesOrderId === scenario.order.id);
    expect(row, 'el pedido facturado tiene que aparecer en el reporte').toBeDefined();

    // Venta sin IGV: el subtotal del comprobante, no su total.
    expect(Number(row!.salesPen)).toBeCloseTo(Number(invoice.subtotalPen), 2);

    // El costo es exactamente el valor que el despacho sacó del kardex, que para una bobina
    // vendida entera es todo lo que valía antes de salir.
    expect(Number(row!.costPen)).toBeCloseTo(coilValueBefore, 2);
    expect(Number(row!.marginPen)).toBeCloseTo(Number(row!.salesPen) - Number(row!.costPen), 2);

    // Reventa de bobina: no hubo producción, así que la columna de planta va en cero y la de
    // margen no. Es la diferencia entre las dos preguntas, visible en el caso más simple.
    expect(Number(row!.opMaterialCostPen)).toBe(0);

    expect(row!.costStatus).toBe('COMPLETO');
    expect(row!.inTotals).toBe(true);

    // El comprobante cuelga del pedido con su propia venta.
    const doc = row!.documents.find((d) => d.id === invoice.id);
    expect(doc, 'la factura emitida tiene que colgar de su pedido').toBeDefined();
    expect(Number(doc!.salesPen)).toBeCloseTo(Number(invoice.subtotalPen), 2);

    // Y la bobina vendida ya no vale nada en el inventario valorizado: el mismo hecho visto
    // desde los dos reportes, que es lo que los hace conciliables entre sí.
    const valuationAfter = await valuation(api);
    const coilAfter = valuationAfter.coilGroups
      .flatMap((g) => g.coils)
      .find((c) => c.id === scenario.coil.id);
    expect(coilAfter, 'una bobina sin saldo sale del inventario valorizado').toBeUndefined();
  });

  test('M2: un rango sin comprobantes devuelve totales en cero y no rompe', async ({ baseURL }) => {
    const api = await adminApi(baseURL!);

    // Un rango de un solo día muy anterior a la carga: no hay nada que pueda caer adentro.
    const report = await margin(api, '2020-01-01', '2020-01-01');

    expect(report.orders).toEqual([]);
    expect(report.totals.salesPen).toBe('0.0000');
    expect(report.totals.costPen).toBe('0.0000');
    expect(report.totals.marginPct).toBeNull();
    expect(report.totals.excludedOrderCount).toBe(0);
  });

  test('M2: rechaza un rango invertido con 400', async ({ baseURL }) => {
    const api = await adminApi(baseURL!);

    const res = await api.get('/api/reports/sales-margin?from=2026-09-30&to=2026-09-01');

    expect(res.status()).toBe(400);
  });
});
