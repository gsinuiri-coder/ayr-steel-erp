import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  adminApi,
  createFinish,
  createSupplier,
  getItems,
  getJson,
  postJson,
} from '../helpers/api';
import {
  closeSessionQuietly,
  openCashSession,
  posSell,
  setupPosStock,
  POS_LINE,
  type CashSessionDto,
} from '../helpers/pos';
import {
  balanceOf,
  createCatalogProduct,
  deactivateTrail,
  putJson,
  randomLetters,
  today,
  type ProductDto,
} from '../helpers/production';
import {
  buyRoofingCoil,
  createColor,
  createRoofingProduct,
  purgeRoofingTrail,
} from '../helpers/roofing';
import {
  createCustomer,
  createQuotationWithLines,
  createSellableProduct,
  purgeSalesTrail,
  stockPanel,
  updateQuotationBody,
  type CustomerDto,
  type QuotationDto,
  type SalesOrderDto,
} from '../helpers/sales';

/**
 * Precios de venta: D-161, D-162 y D-163.
 *
 * Las tres decisiones tocan el mismo número desde ángulos distintos, y por eso viven juntas:
 *
 * - **D-161** — una plancha de catálogo se **negocia por metro** y se **cuenta en planchas**.
 *   El valor unitario deja de ser un dato del formulario y pasa a ser una cuenta del API
 *   (`largo del SKU × valor por metro`), pero la cantidad, la reserva y el despacho siguen en
 *   `NIU`. El par de casos "plancha vs. cobertura a medida" es lo que hace visible la
 *   diferencia: **mismo importe, distinta unidad**.
 * - **D-162** — «valor de venta» es SIN IGV y «precio de venta» es CON IGV. El API recibe y
 *   guarda **valores**; la traducción desde el precio la hace el formulario. El caso de acá
 *   fija ese contrato, que es lo único que un E2E por API puede fijar.
 * - **D-163** — piso duro: `costo ÷ (1 − margen mínimo) × 1.18`. Lo que se protege no es solo
 *   que el rechazo exista, sino que **el mínimo que la pantalla muestra sea tipeable**: el
 *   defecto que se corrigió en esta sesión era que el número mostrado (dos decimales) caía por
 *   debajo del piso (cuatro decimales) al volver a dividirlo por 1.18, así que el sistema
 *   rechazaba el precio que él mismo pedía. Ese es el caso 8.
 *
 * Todo por API y con el mismo patrón de limpieza del resto de la suite (`purgeSalesTrail` y
 * compañía en un `finally`): cada test arma sus propios datos y no depende del orden.
 */

/** Coberturas metálicas: la única línea con subtipo `PLANCHA` (D-127) y cotización obligatoria. */
const ROOFING_LINE = 'metallic-roofing';

/** Largo del SKU de plancha de los casos de D-161: 3.60 m, el factor del defecto original. */
const PLANCHA_LENGTH_MM = '3600.00';

/**
 * D-171: kilos de bobina que **una plancha** de estos casos encarga.
 *
 * Desde D-171 una plancha se rola contra el pedido, así que lo que su línea promete son kilos
 * del agregado de materia prima y no unidades de un saldo terminado. La geometría del SKU de
 * `setupPlancha` es 1 000 mm × 0.50 mm con la densidad por defecto de `createFinish` (7.85), y
 * D-165 mete el 1 % de merma normal dentro de la densidad estándar: `7.85 × 1.01 = 7.9285`.
 *
 * `1000 × 0.50 × 1000 × 7.9285 / 1e6 = 3.96425` kg por metro lineal, y una plancha son 3.60 m.
 */
const KG_PER_SHEET = 3.6 * ((1000 * 0.5 * 1000 * (7.85 * 1.01)) / 1_000_000);

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(
  isProduction,
  'Crea compras, cotizaciones, pedidos y despachos: nunca contra producción (D-126, regla dura 9).',
);

test.describe.configure({ timeout: 180_000 });

// ---------------------------------------------------------------------------
// Aritmética del test, en enteros
// ---------------------------------------------------------------------------

/**
 * Precio con IGV (2 decimales) → valor sin IGV (4 decimales), **exactamente** como lo hace el
 * formulario con `toFixedString(money(saleValueFromPrice(p)), 'MONEY')`.
 *
 * Se hace con enteros y no con `Number(p) / 1.18` a propósito: el caso 8 vive o muere en la
 * cuarta decimal, y una diezmilésima de diferencia por representación binaria convertiría un
 * defecto real en un test verde (o al revés). `precio = P céntimos` ⇒ `valor = P / 118`,
 * redondeado a 4 decimales con half-up, que es el modo de `@ayr/shared`.
 */
function valueFromPrice(pricePen: string): string {
  const cents = Math.round(Number(pricePen) * 100);
  const numerator = cents * 10_000;
  const quotient = Math.floor(numerator / 118);
  const remainder = numerator - quotient * 118;
  const rounded = remainder * 2 >= 118 ? quotient + 1 : quotient;
  return (rounded / 10_000).toFixed(4);
}

/** Un céntimo de valor por debajo: la diezmilésima que tiene que rebotar (D-163). */
function oneTenThousandthBelow(valuePen: string): string {
  return ((Math.round(Number(valuePen) * 10_000) - 1) / 10_000).toFixed(4);
}

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

interface PlanchaScenario {
  supplierId: string;
  finishId: string;
  product: ProductDto;
  purchaseId: string | null;
  /** D-171: la bobina que respalda la reserva de materia prima, cuando el caso la necesita. */
  coilId: string | null;
}

/**
 * Un SKU `PLANCHA` de Metallic Roofing con largo en el maestro (D-127/D-161).
 *
 * Con `coilKg` compra y recibe una **bobina** del mismo espesor y sin color, que es el agregado
 * de materia prima contra el que la línea promete desde D-171: una plancha se rola contra el
 * pedido, así que lo que hace falta para confirmar ya no son planchas en el almacén sino kilos
 * de bobina. Sin `coilKg` el escenario alcanza para cotizar (la cotización no promete material)
 * pero no para confirmar.
 */
async function setupPlancha(
  api: APIRequestContext,
  options: { coilKg?: string; coilUnitPrice?: string } = {},
): Promise<PlanchaScenario> {
  const supplier = await createSupplier(api, { name: 'E2E Proveedor planchas' });
  const finish = await createFinish(api);
  const product = await createCatalogProduct(api, {
    lineCode: ROOFING_LINE,
    unit: 'NIU',
    source: 'PURCHASED',
    roofingKind: 'PLANCHA',
    lengthMm: PLANCHA_LENGTH_MM,
    finishId: finish.id,
    name: 'Plancha E2E de catálogo 3.60 m',
  });
  if (options.coilKg === undefined) {
    return {
      supplierId: supplier.id,
      finishId: finish.id,
      product,
      purchaseId: null,
      coilId: null,
    };
  }

  // Sin color, igual que el SKU: el agregado se empareja por línea, color y espesor (D-134).
  const { coil, purchaseId } = await buyRoofingCoil(api, {
    supplierId: supplier.id,
    finishId: finish.id,
    weightKg: options.coilKg,
    unitPrice: options.coilUnitPrice ?? '5',
  });
  return {
    supplierId: supplier.id,
    finishId: finish.id,
    product,
    purchaseId,
    coilId: coil.id,
  };
}

/** `POST` que debe rebotar con 400; devuelve el cuerpo crudo para poder leer `errors` de Zod. */
async function postExpectingBadRequest(
  api: APIRequestContext,
  path: string,
  data: unknown,
): Promise<string> {
  const res = await api.post(path, { data });
  const body = await res.text();
  expect(res.status(), `POST ${path} debía rechazarse y devolvió ${res.status()}: ${body}`).toBe(
    400,
  );
  return body;
}

/** La cotización de una sola línea, tal como la manda el formulario. */
async function quoteOneLine(
  api: APIRequestContext,
  input: {
    customerId: string;
    businessLine: string;
    productId: string;
    qty: string;
    unitPricePen?: string;
    valuePerMeterPen?: string;
    pieces?: { lengthMm: string; qty: number }[];
  },
): Promise<QuotationDto> {
  const { customerId, businessLine, ...line } = input;
  return createQuotationWithLines(api, { customerId, businessLine, items: [line] });
}

test.describe('D-161 — la plancha de catálogo se cotiza por metro lineal', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('diez planchas de 3.60 m a S/ 7.00 el metro se cotizan por S/ 252, y la reserva son 10 planchas', async () => {
    /**
     * **El defecto que originó D-161, en un caso.** El vendedor negocia S/ 7.00 el metro y el
     * sistema cobraba `10 × 7.00 = 70.00`: 3.6 veces menos, que es exactamente el largo del
     * SKU. Lo que se comprueba es que el importe salga por metro (252.00) **sin** que la línea
     * se pase a metros: la cantidad, la unidad y la reserva siguen en planchas, porque en
     * planchas están el kardex y el despacho.
     */
    const scenario = await setupPlancha(api);
    const customer = await createCustomer(api);
    const quotationIds: string[] = [];

    try {
      const quotation = await quoteOneLine(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: scenario.product.id,
        qty: '10',
        valuePerMeterPen: '7.0000',
      });
      quotationIds.push(quotation.id);

      const line = quotation.items[0]!;
      // 3.60 m × S/ 7.00 = S/ 25.20 por plancha. Un solo redondeo, y del lado del API.
      expect(line.unitPricePen).toBe('25.2000');
      // El número negociado se guarda **junto** al unitario, no en su lugar: es lo que se
      // muestra y lo que se reabre a editar sin tener que dividir.
      expect(line.valuePerMeterPen).toBe('7.0000');
      expect(line.subtotalPen).toBe('252.0000');
      expect(line.qty).toBe('10.000');
      expect(line.unit).toBe('NIU');

      // Lo que la regla dura 14 protege: **la unidad de negociación cambió y la de la línea
      // no**. La cantidad son planchas y la unidad `NIU`, por más que el precio se haya
      // acordado por metro.
      //
      // **D-171 movió lo que la línea reserva, no lo que cuenta.** Hasta acá la reserva era el
      // propio SKU (`PRODUCT`, 10 NIU): una plancha se vendía del almacén. Desde D-171 se rola
      // contra el pedido, así que lo que promete son los kilos de bobina que esos metros van a
      // consumir — 10 planchas × 3.60 m × 3.96425 kg/m. Que la cantidad y la unidad de arriba
      // sigan intactas es justamente lo que muestra que D-161 no se tocó.
      expect(line.reserveItemType).toBe('RAW_MATERIAL');
      expect(line.reserveItemId).not.toBe(scenario.product.id);
      expect(line.reserveQty).toBe((10 * KG_PER_SHEET).toFixed(3));
      expect(line.reserveUnit).toBe('KGM');

      // Y el documento: 252.00 + 18% = 297.36.
      expect(quotation.subtotalPen).toBe('252.0000');
      expect(quotation.igvPen).toBe('45.3600');
      expect(quotation.totalPen).toBe('297.3600');
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await purgeRoofingTrail(api, {
        productIds: [scenario.product.id],
        supplierId: scenario.supplierId,
        finishId: scenario.finishId,
      });
    }
  });

  test('la misma geometría como cobertura a medida da el mismo importe, pero en metros', async () => {
    /**
     * **El par que hace visible la decisión.** Diez piezas de 3.60 m a S/ 7.00 el metro son
     * S/ 252.00 de las dos formas; lo que cambia es *qué se cuenta*:
     *
     * - plancha de catálogo (`NIU`): cantidad **10**, valor unitario 25.2000, valor por metro
     *   guardado aparte;
     * - cobertura a medida (`MTR`): cantidad **36 m**, valor unitario 7.0000 y subítems de
     *   largo, porque la línea entera está en metros (D-083/D-131).
     *
     * Si algún día alguien "unifica" las dos formas pasando la plancha a metros, este caso es
     * el que lo cuenta: el kardex y el despacho de una plancha están en planchas.
     *
     * **D-171 acercó las dos formas por un lado y las dejó separadas por el otro.** Las dos
     * reservan ahora kilos del agregado de materia prima —una plancha se rola contra el pedido,
     * ya no sale del almacén—, pero cada una cuenta lo suyo: la plancha en `NIU` con los metros
     * puestos por el largo del SKU, la cobertura a medida en `MTR` con los metros de la línea.
     * Que la *reserva* haya dejado de distinguirlas es exactamente por qué hace falta que este
     * caso siga mirando la unidad, la cantidad y los subítems.
     */
    const scenario = await setupPlancha(api);
    const color = await createColor(api);
    const madeToMeasure = await createRoofingProduct(api, {
      finishId: scenario.finishId,
      colorId: color.id,
    });
    const customer = await createCustomer(api);
    const quotationIds: string[] = [];

    try {
      const plancha = await quoteOneLine(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: scenario.product.id,
        qty: '10',
        valuePerMeterPen: '7.0000',
      });
      quotationIds.push(plancha.id);

      const aMedida = await quoteOneLine(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: madeToMeasure.product.id,
        qty: '36.000',
        unitPricePen: '7.0000',
        pieces: [{ lengthMm: PLANCHA_LENGTH_MM, qty: 10 }],
      });
      quotationIds.push(aMedida.id);

      const asSheets = plancha.items[0]!;
      const asMeters = aMedida.items[0]!;

      // Mismo dinero...
      expect(asSheets.subtotalPen).toBe('252.0000');
      expect(asMeters.subtotalPen).toBe(asSheets.subtotalPen);
      expect(aMedida.totalPen).toBe(plancha.totalPen);

      // ...y distinta cosa contada.
      expect(asSheets).toMatchObject({
        qty: '10.000',
        unit: 'NIU',
        unitPricePen: '25.2000',
        valuePerMeterPen: '7.0000',
        // D-171: las dos formas reservan materia prima. Lo que sigue distinguiéndolas es lo de
        // abajo —qué se cuenta— y no de dónde sale el material.
        reserveItemType: 'RAW_MATERIAL',
        reserveUnit: 'KGM',
      });
      expect(asMeters).toMatchObject({
        qty: '36.000',
        unit: 'MTR',
        unitPricePen: '7.0000',
        // La línea a medida ya está en metros: no hay largo por el que multiplicar y el
        // campo de D-161 no le corresponde.
        valuePerMeterPen: null,
        // D-134: lo que promete son kilos del agregado de materia prima, no el SKU.
        reserveItemType: 'RAW_MATERIAL',
        reserveUnit: 'KGM',
      });
      expect(asMeters.pieces).toEqual([{ lineNumber: 1, lengthMm: PLANCHA_LENGTH_MM, qty: 10 }]);
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await purgeRoofingTrail(api, {
        productIds: [scenario.product.id, madeToMeasure.product.id],
        supplierId: scenario.supplierId,
        finishId: scenario.finishId,
        colorId: color.id,
      });
    }
  });

  test('el valor por metro y el valor unitario no viajan juntos, y solo los admite una plancha con largo', async () => {
    /**
     * Los dos son un decimal en soles y el compilador nunca avisaría de la confusión, así que
     * las dos puertas se cierran con un 400 explícito:
     *
     * 1. **Los dos a la vez**: el API tendría que elegir cuál gana, en silencio y por un factor
     *    de 3.6.
     * 2. **Valor por metro en algo que no es una plancha con largo**: multiplicar por el largo
     *    solo significa algo si la cantidad de la línea son piezas.
     */
    const scenario = await setupPlancha(api);
    const other = await createSellableProduct(api, { lineCode: POS_LINE, listPricePen: '50.0000' });
    const customer = await createCustomer(api);

    try {
      const bothPrices = await postExpectingBadRequest(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [
          {
            productId: scenario.product.id,
            qty: '10',
            unitPricePen: '25.2000',
            valuePerMeterPen: '7.0000',
          },
        ],
      });
      expect(bothPrices).toContain('no los dos');

      const notASheet = await postExpectingBadRequest(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [{ productId: other.id, qty: '3', valuePerMeterPen: '7.0000' }],
      });
      // El mensaje tiene que decir **por qué** no aplica y qué escribir en su lugar.
      expect(notASheet).toContain('largo fijo');
      expect(notASheet).toContain(other.sku);
    } finally {
      await purgeRoofingTrail(api, {
        productIds: [scenario.product.id, other.id],
        supplierId: scenario.supplierId,
        finishId: scenario.finishId,
      });
    }
  });

  test('el pedido congela el valor por metro, y lo que promete son kilos de bobina', async () => {
    /**
     * La propagación aguas abajo, que es donde D-161 se podría perder: el pedido copia las
     * líneas de la cotización, y si copiara solo el unitario, reabrir el pedido mostraría
     * S/ 25.20 sin decir nunca que se negoció a S/ 7.00 el metro.
     *
     * **D-171 cambió el final del camino, no el número.** El caso terminaba despachando cuatro
     * de las diez planchas del almacén para comprobar que el despacho cuenta en `NIU` y no en
     * 14.4 metros. Desde D-171 esas planchas no están en el almacén —se rolan contra el
     * pedido—, así que despachar exige antes montar una bobina y reportar los largos; ese
     * camino completo, con su despacho en `NIU`, vive en `plancha-contra-pedido-d171.spec.ts`.
     * Lo que queda acá, que es lo de D-161, es que el **valor por metro sobreviva a la
     * confirmación**, y de paso que lo prometido sean kilos de bobina y no unidades.
     *
     * La bobina se compra a S/ 1 el kilo a propósito: con ella el piso de D-163 queda en unos
     * S/ 15.86 por plancha (14.2713 kg × S/ 1 ÷ 0.9) y los S/ 25.20 del caso pasan cómodos.
     * Con el costo de bobina normal de la suite (S/ 5) el piso subiría a S/ 79 y este caso
     * rebotaría por el precio, que es un asunto de otro test.
     */
    const scenario = await setupPlancha(api, { coilKg: '2000', coilUnitPrice: '1' });
    const customer = await createCustomer(api);
    const quotationIds: string[] = [];
    const orderIds: string[] = [];

    try {
      const quotation = await quoteOneLine(api, {
        customerId: customer.id,
        businessLine: ROOFING_LINE,
        productId: scenario.product.id,
        qty: '10',
        valuePerMeterPen: '7.0000',
      });
      quotationIds.push(quotation.id);

      await postJson<QuotationDto>(api, `/api/sales/quotations/${quotation.id}/emit`);
      const order = await postJson<SalesOrderDto>(
        api,
        `/api/sales/quotations/${quotation.id}/confirm`,
        {},
      );
      orderIds.push(order.id);

      const line = order.items[0]!;
      expect(line).toMatchObject({
        qty: '10.000',
        unit: 'NIU',
        unitPricePen: '25.2000',
        valuePerMeterPen: '7.0000',
        subtotalPen: '252.0000',
      });
      expect(order.totalPen).toBe('297.3600');

      // D-171: la promesa del pedido son los kilos que esos metros van a consumir.
      expect(order.reservations).toHaveLength(1);
      expect(order.reservations[0]).toMatchObject({
        itemType: 'RAW_MATERIAL',
        unit: 'KGM',
        qty: (10 * KG_PER_SHEET).toFixed(3),
        status: 'ACTIVE',
      });
    } finally {
      await purgeSalesTrail(api, { orderIds, quotationIds });
      await purgeRoofingTrail(api, {
        productIds: [scenario.product.id],
        ...(scenario.coilId ? { coilIds: [scenario.coilId] } : {}),
        ...(scenario.purchaseId ? { purchaseIds: [scenario.purchaseId] } : {}),
        supplierId: scenario.supplierId,
        finishId: scenario.finishId,
      });
    }
  });
});

test.describe('D-162 — la cotización guarda valores sin IGV', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('el API recibe el valor sin IGV y el precio con IGV sale de él, no al revés', async () => {
    /**
     * D-162 es sobre todo una decisión de **vocabulario**, y la mitad que se puede fijar por
     * API es el contrato: lo que entra en `unitPricePen` es un **valor** (sin IGV) y el
     * documento le suma el 18%. El vendedor tipea S/ 10.00 —el precio que le prometió al
     * cliente— y el formulario manda 8.4746; si algún día el API empezara a interpretar ese
     * campo como precio con IGV, el total dejaría de ser 10.00 y este caso lo diría.
     *
     * El producto no tiene kardex a propósito: sin costo promedio no hay piso (D-163), así que
     * el caso mide la aritmética del IGV y nada más.
     */
    const product = await createSellableProduct(api, {
      lineCode: POS_LINE,
      listPricePen: '50.0000',
    });
    const customer = await createCustomer(api);
    const quotationIds: string[] = [];

    try {
      // 10.00 ÷ 1.18 = 8.474576…, que el formulario redondea a 8.4746.
      expect(valueFromPrice('10.00')).toBe('8.4746');

      const quotation = await quoteOneLine(api, {
        customerId: customer.id,
        businessLine: POS_LINE,
        productId: product.id,
        qty: '1',
        unitPricePen: '8.4746',
      });
      quotationIds.push(quotation.id);

      expect(quotation.items[0]).toMatchObject({
        unitPricePen: '8.4746',
        subtotalPen: '8.4746',
        igvPen: '1.5254',
        totalPen: '10.0000',
      });
      expect(quotation).toMatchObject({
        subtotalPen: '8.4746',
        igvPen: '1.5254',
        totalPen: '10.0000',
      });
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await deactivateTrail(api, { productIds: [product.id] });
    }
  });
});

test.describe('D-163 — piso duro de precio', () => {
  let api: APIRequestContext;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  /** El margen mínimo vigente de una línea, que es lo que decide el piso. */
  async function minMarginPct(lineCode: string): Promise<string> {
    const settings = await getJson<{ businessLineCode: string; minMarginPct: string }[]>(
      api,
      '/api/pricing',
    );
    const setting = settings.find((s) => s.businessLineCode === lineCode);
    expect(setting, `La línea ${lineCode} no tiene márgenes configurados`).toBeDefined();
    return setting!.minMarginPct;
  }

  test('el panel de stock trae el mínimo del SKU, en precio con IGV y en valor sin IGV', async () => {
    /**
     * El piso viaja al formulario **por la misma función** que después rechaza (D-163): si la
     * pantalla lo calculara por su cuenta, podría prometer un mínimo distinto del que el `POST`
     * exige — que es exactamente el defecto que esta sesión corrigió, en su versión de dos
     * decimales.
     *
     * Las dos aserciones que importan: el mínimo mostrado tiene la escala en la que se tipea
     * (céntimos) y, al volver por la cadena de vuelta, **alcanza** el piso en valor.
     */
    const stock = await setupPosStock(api, { qty: '40', unitPrice: '20' });

    try {
      const balance = await balanceOf(api, 'PRODUCT', stock.product.id);
      expect(balance.avgCost).toBe('20.0000');
      const margin = await minMarginPct(POS_LINE);

      const panel = await stockPanel(api, { productIds: [stock.product.id] });
      const row = panel.products.find((p) => p.productId === stock.product.id);
      expect(row, 'el panel no devolvió el SKU pedido').toBeDefined();
      expect(row!.minValuePen).not.toBeNull();
      expect(row!.minPricePen).not.toBeNull();

      // El precio se muestra en céntimos (es lo que una persona tipea) y el valor con la
      // escala de dinero completa (es lo que se guarda y contra lo que se compara).
      expect(row!.minPricePen).toMatch(/^\d+\.\d{2}$/);
      expect(row!.minValuePen).toMatch(/^\d+\.\d{4}$/);

      // `costo ÷ (1 − margen)`, el margen sobre la **venta** de D-163 y no el markup de D-032:
      // con 20.00 y 10%, 22.2222 y no 22.0000.
      const expected = Number(balance.avgCost) / (1 - Number(margin) / 100);
      expect(Number(row!.minValuePen)).toBeCloseTo(expected, 3);
      expect(Number(row!.minValuePen)).toBeGreaterThan(
        Number(balance.avgCost) * (1 + Number(margin) / 100),
      );

      // La invariante de la corrección: **el mínimo mostrado es alcanzable**.
      expect(Number(valueFromPrice(row!.minPricePen!))).toBeGreaterThanOrEqual(
        Number(row!.minValuePen),
      );
    } finally {
      await deactivateTrail(api, {
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        productIds: [stock.product.id],
      });
    }
  });

  test('exactamente en el mínimo se cotiza; una diezmilésima por debajo rebota nombrando el mínimo', async () => {
    const stock = await setupPosStock(api, { qty: '40', unitPrice: '20' });
    const customer = await createCustomer(api);
    const quotationIds: string[] = [];

    try {
      const panel = await stockPanel(api, { productIds: [stock.product.id] });
      const floor = panel.products.find((p) => p.productId === stock.product.id)!;
      const minValuePen = floor.minValuePen!;

      // 1. Exactamente en el mínimo **pasa**. La comparación es valor contra valor (D-163):
      //    si se hiciera precio contra precio, este caso rebotaría por una diezmilésima.
      const atFloor = await quoteOneLine(api, {
        customerId: customer.id,
        businessLine: POS_LINE,
        productId: stock.product.id,
        qty: '2',
        unitPricePen: minValuePen,
      });
      quotationIds.push(atFloor.id);
      expect(atFloor.items[0]!.unitPricePen).toBe(minValuePen);

      // 2. Un céntimo (de valor) por debajo, **no**. Y el mensaje trae el mínimo, el costo y
      //    la salida legítima: cambiar el margen, que queda auditado.
      const refused = await postExpectingBadRequest(api, '/api/sales/quotations', {
        customerId: customer.id,
        issueDate: today(),
        items: [
          {
            productId: stock.product.id,
            qty: '2',
            unitPricePen: oneTenThousandthBelow(minValuePen),
          },
        ],
      });
      expect(refused).toContain(stock.product.sku);
      expect(refused).toContain(`S/ ${floor.minPricePen}`);
      expect(refused).toContain('mínimo');
      expect(refused).toContain('Márgenes');
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await deactivateTrail(api, {
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        productIds: [stock.product.id],
      });
    }
  });

  test('tipear el mínimo que muestra la pantalla se guarda: es la regresión que se corrigió', async () => {
    /**
     * **El caso que estaba roto.** El mínimo se muestra con dos decimales y el piso vive con
     * cuatro: recortar hacia abajo hacía que tipear exactamente el número de la pantalla
     * cayera por debajo, y el sistema respondiera «sube el precio» sobre el precio que él
     * mismo pedía. Pasaba en cerca de la mitad de las combinaciones.
     *
     * El test recorre la cadena entera tal como la recorre el vendedor: lee `minPricePen` del
     * panel, lo divide por 1.18 y lo redondea a cuatro decimales —lo que hace el formulario— y
     * cotiza con ese valor. Tiene que crearse. Si vuelve a fallar, es una regresión.
     *
     * El costo es 17.50 y no 20.00 a propósito: es la combinación con la que se descubrió el
     * defecto (piso 19.4444, precio 22.9444 → «22.94» → 19.4407, por debajo).
     */
    const stock = await setupPosStock(api, { qty: '40', unitPrice: '17.5' });
    const customer = await createCustomer(api);
    const quotationIds: string[] = [];

    try {
      const panel = await stockPanel(api, { productIds: [stock.product.id] });
      const floor = panel.products.find((p) => p.productId === stock.product.id)!;
      const typed = floor.minPricePen!;
      const derived = valueFromPrice(typed);

      const quotation = await quoteOneLine(api, {
        customerId: customer.id,
        businessLine: POS_LINE,
        productId: stock.product.id,
        qty: '3',
        unitPricePen: derived,
      });
      quotationIds.push(quotation.id);
      expect(quotation.items[0]!.unitPricePen).toBe(derived);
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await deactivateTrail(api, {
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        productIds: [stock.product.id],
      });
    }
  });

  test('el mostrador no tiene piso: la venta de caja por debajo del mínimo se completa', async () => {
    /**
     * **Exención deliberada de D-163.** El carrito de caja no tiene dónde mostrar el mínimo: el
     * cajero lo descubriría al cobrar, con el cliente delante, y el rechazo tiraría abajo la
     * transacción entera de D-099 (pedido, despacho, comprobante y cobro). Antes de esta
     * sesión el mostrador tampoco tenía piso, así que dejarlo afuera no abre nada nuevo.
     *
     * Se comprueba con un precio **por debajo del costo**, no solo por debajo del margen: si
     * alguien pusiera el piso también en el mostrador, este caso se cae y hay que decidirlo a
     * propósito, no descubrirlo en caja.
     */
    const stock = await setupPosStock(api, { qty: '40', unitPrice: '20' });
    let session: CashSessionDto | undefined;
    const orderIds: string[] = [];

    try {
      const panel = await stockPanel(api, { productIds: [stock.product.id] });
      const floor = panel.products.find((p) => p.productId === stock.product.id)!;
      expect(floor.minValuePen, 'sin piso el caso no prueba nada').not.toBeNull();
      expect(Number(floor.minValuePen)).toBeGreaterThan(5);

      session = await openCashSession(api, '0.00');
      const sale = await posSell(api, {
        items: [{ productId: stock.product.id, qty: '2.000', unitPricePen: '5.0000' }],
      });
      orderIds.push(sale.salesOrderId);
      expect(sale.status).toBe('ACTIVE');
      // 2 × 5.00 = 10.00 + IGV.
      expect(sale.totalPen).toBe('11.8000');
    } finally {
      await closeSessionQuietly(api, session?.id);
      await purgeSalesTrail(api, { orderIds });
      await deactivateTrail(api, {
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        productIds: [stock.product.id],
      });
    }
  });

  test('una cotización importada entra por debajo del piso, y editarla tampoco rebota', async () => {
    /**
     * La otra exención de D-163, y la razón por la que existe: lo que trae el importador
     * (D-152) ya se vendió, a los precios a los que se vendió. Aplicarle el margen mínimo de
     * hoy dejaría agosto sin cargar — es la misma lógica por la que una cotización importada no
     * vence (D-157): lo que entra por ahí es un hecho consumado, no una oferta.
     *
     * Y la segunda mitad, que es la que se olvida: **editarla sigue exento**. Corregir el
     * producto de una línea no convierte el documento en una oferta nueva.
     *
     * Ojo con las observaciones: la exención se deduce del prefijo «Factura externa: » que el
     * importador deja ahí (`isImportedQuotation`), y el `PUT` reemplaza las observaciones con
     * lo que venga en el cuerpo. Por eso el test las reenvía, que es lo que tiene que hacer
     * cualquier cliente que edite una importada.
     */
    const stock = await setupPosStock(api, { qty: '40', unitPrice: '20' });
    const customer = await createCustomer(api);
    const quotationIds: string[] = [];

    try {
      const panel = await stockPanel(api, { productIds: [stock.product.id] });
      const floor = panel.products.find((p) => p.productId === stock.product.id)!;
      // El precio del papel: S/ 5.00 por unidad, muy por debajo del piso de hoy.
      expect(Number(floor.minValuePen)).toBeGreaterThan(5);

      const documentKey = `FFA1-${randomLetters(4)}`;
      const parsed = await previewImport(api, {
        customer,
        product: stock.product,
        documentKey,
        qty: '10.000',
        netAmount: '50.00',
      });
      expect(parsed.rows[0]!.unitPricePen).toBe('5.0000');
      expect(parsed.rows[0]!.issues.filter((i) => i.severity === 'error')).toEqual([]);

      const result = await postJson<{ codes: string[] }>(api, '/api/imports/quotations', {
        rows: parsed.rows.map((r) => ({
          rowNumber: r.rowNumber,
          documentKey: r.documentKey,
          issueDate: r.issueDate,
          customerId: r.customerId,
          productId: r.productId,
          qty: r.qty,
          unitPricePen: r.unitPricePen,
        })),
      });
      const all = await getItems<{ id: string; code: string }>(api, '/api/sales/quotations');
      const imported = all.find((q) => result.codes.includes(q.code));
      expect(imported, 'la cotización importada no aparece en el listado').toBeDefined();
      quotationIds.push(imported!.id);

      const detail = await getJson<QuotationDto & { notes: string | null }>(
        api,
        `/api/sales/quotations/${imported!.id}`,
      );
      expect(detail.items[0]!.unitPricePen).toBe('5.0000');
      expect(detail.notes).toContain('Factura externa: ');

      // Editarla: se corrige la cantidad y se deja el precio histórico. Sin la exención esto
      // rebotaría con «el precio mínimo es S/ …» sobre una línea que nadie tocó.
      const edited = await putJson<QuotationDto>(api, `/api/sales/quotations/${imported!.id}`, {
        ...updateQuotationBody({
          customerId: customer.id,
          items: [{ productId: stock.product.id, qty: '8.000', unitPricePen: '5.0000' }],
        }),
        notes: detail.notes ?? undefined,
      });
      expect(edited.items[0]!.qty).toBe('8.000');
      expect(edited.items[0]!.unitPricePen).toBe('5.0000');
    } finally {
      await purgeSalesTrail(api, { quotationIds });
      await deactivateTrail(api, {
        purchaseId: stock.purchaseId,
        supplierId: stock.supplier.id,
        productIds: [stock.product.id],
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Importador de cotizaciones (D-152), lo mínimo para el caso de la exención
// ---------------------------------------------------------------------------

const IMPORT_HEADERS = [
  'F. EMISIÓN',
  'TIPO COMPROBANTE',
  'SERIE - NÚMERO',
  'CLIENTE',
  'MONEDA',
  'TIPOCAMBIO',
  'DOCUMENTO AJUSTADO',
  'CÓDIGO PRODUCTO',
  'NOMBRE PRODUCTO',
  'UNIDAD MEDIDA',
  'CANTIDAD',
  'VALOR DE VENTA',
];

interface ImportPreviewDto {
  rows: {
    rowNumber: number;
    documentKey: string;
    issueDate: string;
    customerId: string | null;
    productId: string | null;
    qty: string;
    unitPricePen: string;
    issues: { field: string; severity: 'error' | 'warning'; message: string }[];
  }[];
  quotations: number;
}

/** Una sola fila del export de ventas, que es todo lo que este caso necesita. */
async function previewImport(
  api: APIRequestContext,
  input: {
    customer: CustomerDto;
    product: ProductDto;
    documentKey: string;
    qty: string;
    netAmount: string;
  },
): Promise<ImportPreviewDto> {
  const row = [
    '03/08/2026',
    'Factura',
    input.documentKey,
    `${input.customer.docNumber} - ${input.customer.name.replace(/,/g, ' ')}`,
    'Soles',
    '',
    '',
    input.product.sku,
    input.product.name.replace(/,/g, ' '),
    'UNIDAD',
    input.qty,
    input.netAmount,
  ].join(',');
  const res = await api.post('/api/imports/quotations/preview', {
    multipart: {
      file: {
        name: 'ventas.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from([IMPORT_HEADERS.join(','), row].join('\n'), 'utf8'),
      },
    },
  });
  expect(res.ok(), `la previsualización falló: ${await res.text()}`).toBe(true);
  return (await res.json()) as ImportPreviewDto;
}
