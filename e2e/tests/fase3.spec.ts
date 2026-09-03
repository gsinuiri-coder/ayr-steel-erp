import { expect, request, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import {
  adminApi,
  createFinish,
  createSupplier,
  createUser,
  getJson,
  postJson,
  type CreatedFinish,
  type CreatedSupplier,
  type CreatedUser,
} from '../helpers/api';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Fase 3 (D-047..D-050): corte tercerizado (RF-40..42) y su cancelación (RF-22). Enviar
 * una bobina a corte no mueve kardex (D-050); recibirla sí, con el mismo reparto por
 * ancho que el partido interno (RF-15), sobre bobinas hijas `kind=STRIP`. Todo lo que
 * mueve kardex —recibir y cancelar imputan o liberan kilos— así que, igual que Fase 2b,
 * contra producción solo corre si se pide de forma explícita (D-024).
 *
 * Reversión: cada test cancela en su `finally` la orden de corte que quedó pendiente
 * (libera las bobinas SENT sin necesidad de reversa, D-050), anula las compras que el
 * dominio todavía permite anular y desactiva los maestros que creó —proveedor y acabado,
 * más el producto de trading que nace de la primera bobina de cada tipo (D-037)—, igual
 * que `fase2b.spec.ts`.
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

const ROLE_PASSWORD = 'ClaveRolE2E-2026';

/** Línea con inventario (`STOCK`) donde viven las bobinas de estas pruebas. */
const LINE = 'drywall';

// ---------------------------------------------------------------------------
// DTOs mínimos del API que consumen los tests (el spec no importa @ayr/shared)
// ---------------------------------------------------------------------------

interface PurchaseDto {
  id: string;
  series: string;
  number: string;
  type: string;
  status: string;
  subtotal: string;
  total: string;
  balance: string;
  serviceKind: string | null;
  relatedCuttingOrderId: string | null;
}

interface CoilDto {
  id: string;
  code: string;
  kind: string;
  typeKey: string;
  businessLine: string;
  purchaseId: string | null;
  status: string;
  weightKg: string;
  widthMm: string;
  thicknessMm: string;
  unitCostPerKg: string;
  totalCostPen: string;
  parentCoilId: string | null;
  splitId: string | null;
  availableKg: string;
}

interface WidthCountDto {
  widthMm: string;
  stripsCount: number;
}

interface CuttingOrderCoilDto {
  id: string;
  cuttingOrderId: string;
  coilId: string;
  coilCode: string;
  coilWidthMm: string;
  coilAvailableKg: string;
  widthPlanMm: WidthCountDto[];
  expectedKerfLossMm: string;
  status: string;
  receivedAt: string | null;
  receivedWidthsMm: WidthCountDto[] | null;
  receivedWeightKg: string | null;
  receivedKerfLossMm: string | null;
  receivedKerfLossKg: string | null;
  cancelledAt: string | null;
  strips: { id: string; code: string; widthMm: string; weightKg: string }[];
  createdAt: string;
}

interface CuttingOrderDto {
  id: string;
  supplierId: string;
  supplierName: string;
  businessLine: string;
  status: string;
  sentAt: string;
  cancelledAt: string | null;
  notes: string | null;
  services: { purchaseId: string; documentLabel: string; status: string; amountPen: string }[];
  coils: CuttingOrderCoilDto[];
  createdAt: string;
}

interface StripStockRowDto {
  typeKey: string;
  finishCode: string;
  thicknessMm: string;
  widthMm: string;
  qtyKg: string;
  avgCostPen: string | null;
  totalValuePen: string | null;
  coilCount: number;
}

interface BalanceDto {
  itemId: string;
  qty: string;
  avgCost: string | null;
  totalValue: string | null;
}

interface ProductDto {
  id: string;
  sku: string;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Correlativo de comprobante único: dos corridas seguidas no chocan contra el índice
 *  único (proveedor, tipo, serie, número), que no se resetea fuera de CI. */
function uniqueDocumentNumber(): string {
  return String(Date.now()).slice(-9);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Letras mayúsculas al azar: los códigos de proveedor (RF-13) no admiten dígitos. */
function randomLetters(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/**
 * Proveedor de prueba que sí presta servicio de corte tercerizado (RF-81): `createSupplier`
 * de `e2e/helpers/api.ts` no expone ese campo en sus overrides, así que se replica acá el
 * mismo POST directo que usa el helper, con `providesCuttingService: true`.
 */
async function createCuttingSupplier(api: APIRequestContext): Promise<CreatedSupplier> {
  const code = `EC${randomLetters(4)}`;
  return postJson<CreatedSupplier>(api, '/api/suppliers', {
    code,
    docType: 'RUC',
    docNumber: `20${String(Date.now()).slice(-9)}`,
    name: `E2E Proveedor de corte ${code}`,
    creditDays: 0,
    providesCuttingService: true,
  });
}

interface CoilLineInput {
  description: string;
  weightKg: string;
  widthMm: string;
  thicknessMm: string;
  unitPricePerKg: string;
}

/**
 * Compra de bobinas ya recibida: una bobina por línea, con su ingreso en el kardex
 * (D-030). Copiada de `fase2b.spec.ts`: lo que prueban estos tests empieza después de la
 * recepción, con las bobinas ya disponibles para enviarlas a corte.
 */
async function receivedCoilPurchase(
  api: APIRequestContext,
  input: { supplier: CreatedSupplier; finish: CreatedFinish; lines: CoilLineInput[] },
): Promise<{ purchase: PurchaseDto; coils: CoilDto[] }> {
  const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
    supplierId: input.supplier.id,
    businessLine: LINE,
    type: 'COIL',
    docType: 'FACTURA',
    series: 'F001',
    number: uniqueDocumentNumber(),
    issueDate: today(),
    currency: 'PEN',
    igvRate: '18',
    paymentTerms: 'CONTADO',
    items: input.lines.map((line) => ({
      description: line.description,
      qty: line.weightKg,
      unit: 'KGM',
      unitPrice: line.unitPricePerKg,
      finishId: input.finish.id,
      widthMm: line.widthMm,
      thicknessMm: line.thicknessMm,
    })),
  });
  const received = await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/receive`);
  expect(received.status).toBe('RECEIVED');

  const coils = await getJson<CoilDto[]>(api, `/api/coils?supplierId=${input.supplier.id}`);
  expect(coils.length).toBe(input.lines.length);
  return { purchase: received, coils };
}

/** Saldo del kardex de una bobina o fleje (cantidad y costo promedio vigente). */
async function coilBalance(api: APIRequestContext, coilId: string): Promise<BalanceDto> {
  const balances = await getJson<BalanceDto[]>(
    api,
    `/api/inventory/balances?itemType=COIL&itemId=${coilId}`,
  );
  expect(balances, `La bobina ${coilId} no tiene saldo de kardex`).toHaveLength(1);
  return balances[0]!;
}

/**
 * Contexto de API autenticado como un usuario recién creado (copiado de `fase2b.spec.ts`).
 * El primer ingreso obliga a cambiar la contraseña temporal (RF-01) antes de dejar pasar
 * cualquier otra operación.
 */
async function apiAs(baseURL: string, user: CreatedUser): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL });
  const login = await api.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  if (!login.ok()) {
    throw new Error(`Login de ${user.role} falló: ${login.status()} ${await login.text()}`);
  }
  const changed = await api.post('/api/auth/change-password', {
    data: {
      currentPassword: user.password,
      newPassword: ROLE_PASSWORD,
      confirmPassword: ROLE_PASSWORD,
    },
  });
  if (!changed.ok()) {
    throw new Error(
      `Cambio de contraseña de ${user.role} falló: ${changed.status()} ${await changed.text()}`,
    );
  }
  return api;
}

interface ApiError {
  status: number;
  message: string;
}

/** Estado y mensaje de una respuesta que se esperaba fallida. */
async function errorFrom(res: APIResponse, label: string): Promise<ApiError> {
  expect(res.ok(), `${label} debía fallar y devolvió ${res.status()}`).toBe(false);
  const body = (await res.json()) as { message?: string | string[] };
  const message = Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? '');
  return { status: res.status(), message };
}

/** POST que se espera que falle: devuelve el estado y el mensaje del API tal cual. */
async function postExpectingError(
  api: APIRequestContext,
  path: string,
  data?: unknown,
): Promise<ApiError> {
  const res = await api.post(path, data === undefined ? undefined : { data });
  return errorFrom(res, `POST ${path}`);
}

/**
 * Deja inerte en producción lo que el test creó: cancela primero la orden de corte que
 * haya quedado con bobinas pendientes (D-050: liberarlas no necesita reversa, solo
 * vuelven a `OPEN`), después anula las compras que todavía admiten anulación —el
 * servicio de corte antes que la compra de bobinas, porque su `ADJUST` tiene que
 * revertirse primero— y por último desactiva proveedores, acabado y el producto de
 * trading que nace de la primera bobina de cada tipo (D-037). Nunca lanza: es limpieza
 * de `finally`.
 */
async function deactivateTrail(
  api: APIRequestContext,
  trail: {
    cuttingOrderId?: string;
    purchaseIds?: string[];
    supplierIds?: string[];
    finish?: CreatedFinish;
  },
): Promise<void> {
  if (trail.cuttingOrderId) {
    await api
      .post(`/api/cutting/${trail.cuttingOrderId}/cancel`, {
        data: { reason: 'Limpieza de prueba E2E' },
      })
      .catch(() => undefined);
  }
  for (const purchaseId of trail.purchaseIds ?? []) {
    await api
      .post(`/api/purchases/${purchaseId}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
      .catch(() => undefined);
  }
  for (const supplierId of trail.supplierIds ?? []) {
    await api
      .patch(`/api/suppliers/${supplierId}`, { data: { isActive: false } })
      .catch(() => undefined);
  }
  if (trail.finish) {
    await api
      .patch(`/api/finishes/${trail.finish.id}`, { data: { isActive: false } })
      .catch(() => undefined);
    // D-037: la primera bobina de cada tipo crea un producto `BOB{acabado}{espesor}`.
    const products = await getJson<ProductDto[]>(api, '/api/catalog?businessLine=trading').catch(
      () => [] as ProductDto[],
    );
    for (const product of products.filter((p) => p.sku.startsWith(`BOB${trail.finish?.code}`))) {
      await api
        .patch(`/api/catalog/${product.id}`, { data: { isActive: false } })
        .catch(() => undefined);
    }
  }
}

test.describe('Fase 3 — corte tercerizado (RF-40..42, RF-22, D-047..D-050)', () => {
  test.skip(skipWrites, 'Mueve kardex: en produccion solo con E2E_ALLOW_WRITES=1');

  // Cada escenario encadena varias operaciones transaccionales contra Neon (compra,
  // recepción, envío a corte, recepción del corte, compra de servicio y cancelación).
  // El timeout global de 45 s queda corto.
  test.beforeEach(() => {
    test.setTimeout(150_000);
  });

  test('enviar una bobina a corte la saca del partido local; recibirla crea flejes prorrateados que el servicio factura y encarece, y lo que queda sin cortar se cancela (RF-40, RF-41, RF-42, RF-22, D-049, D-050)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';
    let servicePurchaseId = '';
    let orderId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E enviada a corte tercerizado',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
          {
            description: 'Bobina E2E que se queda pendiente de cortar',
            weightKg: '2000',
            widthMm: '1000',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const motherA = coils.find((c) => c.weightKg === '5000.000')!;
      const motherB = coils.find((c) => c.weightKg === '2000.000')!;
      expect(motherA, 'No se creó la bobina de 5 000 kg').toBeDefined();
      expect(motherB, 'No se creó la bobina de 2 000 kg').toBeDefined();
      expect(motherA.kind).toBe('COIL');

      // --- RF-40: enviar las 2 bobinas a corte con su plan de anchos ---
      const order = await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: supplier.id,
        notes: 'Orden E2E de corte tercerizado',
        coils: [
          {
            coilId: motherA.id,
            widthPlanMm: [
              { widthMm: '600', stripsCount: 1 },
              { widthMm: '560', stripsCount: 1 },
            ],
            expectedKerfLossMm: '60',
          },
          {
            coilId: motherB.id,
            widthPlanMm: [
              { widthMm: '500', stripsCount: 1 },
              { widthMm: '480', stripsCount: 1 },
            ],
            expectedKerfLossMm: '20',
          },
        ],
      });
      orderId = order.id;
      expect(order).toMatchObject({
        supplierId: supplier.id,
        status: 'SENT',
        notes: 'Orden E2E de corte tercerizado',
      });
      expect(order.coils).toHaveLength(2);
      const rowA = order.coils.find((c) => c.coilId === motherA.id)!;
      const rowB = order.coils.find((c) => c.coilId === motherB.id)!;
      expect(rowA).toMatchObject({
        coilCode: motherA.code,
        coilWidthMm: '1220.00',
        coilAvailableKg: '5000.000',
        expectedKerfLossMm: '60.00',
        status: 'SENT',
        strips: [],
      });
      expect(rowB).toMatchObject({
        coilCode: motherB.code,
        coilWidthMm: '1000.00',
        coilAvailableKg: '2000.000',
        status: 'SENT',
        strips: [],
      });

      // D-050: el envío no mueve kardex. Las 2 bobinas quedan fuera de circulación local.
      for (const mother of [motherA, motherB]) {
        const after = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
        expect(after.status).toBe('IN_THIRD_PARTY');
        expect(after.availableKg).toBe(mother.availableKg);
      }

      // Y mientras esté en el tercero, no se puede partir localmente (RF-15).
      const blockedSplit = await postExpectingError(api, `/api/coils/${motherA.id}/split`, {
        kerfLossMm: '0',
        children: [{ widthMm: '400', count: 1 }],
      });
      expect(blockedSplit.status).toBe(400);

      // --- RF-41: recibir solo la bobina A, con kilos reales y una merma ---
      const receivedA = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${motherA.id}/receive`,
        {
          receivedWidthsMm: [
            { widthMm: '600', stripsCount: 1 },
            { widthMm: '560', stripsCount: 1 },
          ],
          receivedWeightKg: '3000',
          kerfLossMm: '0',
        },
      );
      // Con la B todavía SENT, la orden queda a medias.
      expect(receivedA.status).toBe('PARTIALLY_RECEIVED');
      const rowAReceived = receivedA.coils.find((c) => c.coilId === motherA.id)!;
      const rowBStillSent = receivedA.coils.find((c) => c.coilId === motherB.id)!;
      expect(rowAReceived).toMatchObject({
        status: 'RECEIVED',
        receivedWeightKg: '3000.000',
        receivedKerfLossMm: '0.00',
        // Prorrateo por ancho sobre el ancho de la madre (RF-15/RF-41), la misma
        // aritmética que el partido interno: 3000 × 600/1220 = 1475.410 y el resto.
        receivedKerfLossKg: '147.541',
      });
      expect(rowAReceived.strips).toHaveLength(2);
      expect(rowBStillSent.status).toBe('SENT');
      expect(rowBStillSent.strips).toHaveLength(0);

      const strip600 = rowAReceived.strips.find((s) => s.widthMm === '600.00')!;
      const strip560 = rowAReceived.strips.find((s) => s.widthMm === '560.00')!;
      expect(strip600.weightKg).toBe('1475.410');
      expect(strip560.weightKg).toBe('1377.049');

      // La madre A conserva su ancho, pierde solo el peso partido y vuelve a OPEN porque
      // le sobró material (D-050, RF-19); la B sigue IN_THIRD_PARTY.
      const motherAAfterReceive = await getJson<CoilDto>(api, `/api/coils/${motherA.id}`);
      expect(motherAAfterReceive).toMatchObject({
        status: 'OPEN',
        widthMm: '1220.00',
        availableKg: '2000.000',
      });
      expect((await getJson<CoilDto>(api, `/api/coils/${motherB.id}`)).status).toBe(
        'IN_THIRD_PARTY',
      );

      // Cada fleje es hija de la madre, sin partido asociado (D-049: nace de `cutting`,
      // no de `coils/:id/split`), y hereda el costo por kg vigente de la madre.
      for (const [strip, weightKg] of [
        [strip600, '1475.410'],
        [strip560, '1377.049'],
      ] as const) {
        const stripCoil = await getJson<CoilDto>(api, `/api/coils/${strip.id}`);
        expect(stripCoil).toMatchObject({
          kind: 'STRIP',
          parentCoilId: motherA.id,
          splitId: null,
          purchaseId: motherA.purchaseId,
          status: 'OPEN',
          typeKey: motherA.typeKey,
          businessLine: LINE,
          weightKg,
          availableKg: weightKg,
          unitCostPerKg: '4.0000',
        });
      }

      // RF-42: el stock de flejes agrupa por typeKey + ancho, a diferencia del resumen
      // de bobinas (RF-51), que agrupa solo por typeKey.
      const stripsBefore = await getJson<StripStockRowDto[]>(
        api,
        `/api/cutting/strips?businessLine=${LINE}`,
      );
      const row600 = stripsBefore.find(
        (r) => r.typeKey === motherA.typeKey && r.widthMm === '600.00',
      );
      const row560 = stripsBefore.find(
        (r) => r.typeKey === motherA.typeKey && r.widthMm === '560.00',
      );
      expect(row600, 'No aparece el fleje de 600 mm en /cutting/strips').toBeDefined();
      expect(row560, 'No aparece el fleje de 560 mm en /cutting/strips').toBeDefined();
      expect(row600).toMatchObject({ qtyKg: '1475.410', avgCostPen: '4.0000', coilCount: 1 });
      expect(row560).toMatchObject({ qtyKg: '1377.049', avgCostPen: '4.0000', coilCount: 1 });

      // --- Costo del servicio de corte (RF-41): compra SERVICE/CUTTING vinculada ---
      const service = await postJson<PurchaseDto>(api, '/api/purchases', {
        supplierId: supplier.id,
        businessLine: LINE,
        type: 'SERVICE',
        docType: 'FACTURA',
        series: 'F001',
        number: uniqueDocumentNumber(),
        issueDate: today(),
        currency: 'PEN',
        igvRate: '18',
        paymentTerms: 'CONTADO',
        serviceKind: 'CUTTING',
        relatedCuttingOrderId: orderId,
        items: [
          {
            description: 'Servicio de corte tercerizado E2E',
            qty: '1',
            unit: 'ZZ',
            unitPrice: '600',
          },
        ],
      });
      servicePurchaseId = service.id;
      expect(service).toMatchObject({
        type: 'SERVICE',
        serviceKind: 'CUTTING',
        relatedCuttingOrderId: orderId,
        subtotal: '600.0000',
        status: 'DRAFT',
      });

      // Mientras el servicio siga en borrador, no toca el costo de los flejes (D-030).
      expect((await getJson<CoilDto>(api, `/api/coils/${strip600.id}`)).unitCostPerKg).toBe(
        '4.0000',
      );

      const serviceReceived = await postJson<PurchaseDto>(
        api,
        `/api/purchases/${service.id}/receive`,
      );
      expect(serviceReceived.status).toBe('RECEIVED');

      // Reparto por kilo entre los 2 flejes recibidos: 600 soles sobre 2 852.459 kg.
      const strip600After = await getJson<CoilDto>(api, `/api/coils/${strip600.id}`);
      const strip560After = await getJson<CoilDto>(api, `/api/coils/${strip560.id}`);
      expect(strip600After).toMatchObject({ unitCostPerKg: '4.2103', totalCostPen: '6211.9849' });
      expect(strip560After).toMatchObject({ unitCostPerKg: '4.2103', totalCostPen: '5797.8511' });
      // El kilaje disponible no cambia: es un ajuste de costo, no de cantidad.
      expect(strip600After.availableKg).toBe('1475.410');
      expect(strip560After.availableKg).toBe('1377.049');
      expect((await coilBalance(api, strip600.id)).avgCost).toBe('4.2103');
      expect((await coilBalance(api, strip560.id)).avgCost).toBe('4.2103');

      // La orden refleja el servicio ya imputado.
      const orderWithService = await getJson<CuttingOrderDto>(api, `/api/cutting/${orderId}`);
      expect(orderWithService.services).toHaveLength(1);
      expect(orderWithService.services[0]).toMatchObject({
        purchaseId: service.id,
        documentLabel: `${service.series}-${service.number}`,
        status: 'RECEIVED',
        amountPen: '600.0000',
      });

      // --- RF-22: cancelar lo que quedó sin cortar (la bobina B) ---
      const cancelled = await postJson<CuttingOrderDto>(api, `/api/cutting/${orderId}/cancel`, {
        reason: 'La bobina B se necesita entera para otro pedido',
      });
      // Ya no queda ninguna fila SENT: pasa a un estado terminal, RECEIVED porque algo sí
      // se llegó a cortar (deriveCuttingOrderStatus).
      expect(cancelled.status).toBe('RECEIVED');
      const rowBCancelled = cancelled.coils.find((c) => c.coilId === motherB.id)!;
      expect(rowBCancelled.status).toBe('CANCELLED');
      expect(rowBCancelled.cancelledAt).not.toBeNull();

      // La bobina B vuelve a OPEN con su kilaje intacto: nunca tuvo movimiento de kardex.
      const motherBAfterCancel = await getJson<CoilDto>(api, `/api/coils/${motherB.id}`);
      expect(motherBAfterCancel.status).toBe('OPEN');
      expect(motherBAfterCancel.availableKg).toBe('2000.000');
    } finally {
      if (isProduction) {
        // La orden ya quedó sin filas pendientes (se recibió A y se canceló B); el
        // servicio se anula antes que la compra de bobinas para revertir el ADJUST.
        await deactivateTrail(api, {
          cuttingOrderId: orderId || undefined,
          purchaseIds: [servicePurchaseId, purchaseId].filter(Boolean),
          supplierIds: [supplier.id],
          finish,
        });
      }
    }
  });

  test('un plan de corte cuyos anchos más la merma superan el ancho de la bobina se rechaza y no toca la bobina (RF-40)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createCuttingSupplier(api);
    const plainSupplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E de un ancho angosto',
            weightKg: '2000',
            widthMm: '1000',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const coil = coils[0]!;

      // El proveedor de la orden tiene que prestar servicio de corte (RF-81).
      const deniedProvider = await postExpectingError(api, '/api/cutting', {
        supplierId: plainSupplier.id,
        coils: [
          {
            coilId: coil.id,
            widthPlanMm: [{ widthMm: '400', stripsCount: 1 }],
            expectedKerfLossMm: '0',
          },
        ],
      });
      expect(deniedProvider.status).toBe(400);
      expect(deniedProvider.message).toContain('no presta servicio de corte tercerizado');

      // 700 + 400 = 1 100 mm, ya por encima de los 1 000 mm de la bobina, sin sumar merma.
      const rejected = await postExpectingError(api, '/api/cutting', {
        supplierId: supplier.id,
        coils: [
          {
            coilId: coil.id,
            widthPlanMm: [
              { widthMm: '700', stripsCount: 1 },
              { widthMm: '400', stripsCount: 1 },
            ],
            expectedKerfLossMm: '0',
          },
        ],
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('superan el ancho');

      // Nada quedó a medias: la bobina sigue abierta y no hay ninguna orden de corte.
      const untouched = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
      expect(untouched.status).toBe('OPEN');
      expect(untouched.availableKg).toBe('2000.000');
      expect(await getJson<unknown[]>(api, `/api/cutting?supplierId=${supplier.id}`)).toHaveLength(
        0,
      );
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierIds: [supplier.id, plainSupplier.id],
          finish,
        });
      }
    }
  });

  test('cancelar una orden con una bobina recibida y otra pendiente anula solo la pendiente y no se puede repetir (RF-22)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';
    let orderId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E que sí se corta',
            weightKg: '3000',
            widthMm: '1200',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
          {
            description: 'Bobina E2E que se queda sin cortar',
            weightKg: '2000',
            widthMm: '1000',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const cutCoil = coils.find((c) => c.weightKg === '3000.000')!;
      const pendingCoil = coils.find((c) => c.weightKg === '2000.000')!;

      const order = await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: supplier.id,
        coils: [
          {
            coilId: cutCoil.id,
            widthPlanMm: [{ widthMm: '500', stripsCount: 2 }],
            expectedKerfLossMm: '20',
          },
          {
            coilId: pendingCoil.id,
            widthPlanMm: [{ widthMm: '480', stripsCount: 2 }],
            expectedKerfLossMm: '20',
          },
        ],
      });
      orderId = order.id;

      const received = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${cutCoil.id}/receive`,
        {
          receivedWidthsMm: [{ widthMm: '500', stripsCount: 2 }],
          receivedWeightKg: '3000',
          kerfLossMm: '0',
        },
      );
      // Con una bobina recibida y la otra todavía SENT, la orden queda a medias.
      expect(received.status).toBe('PARTIALLY_RECEIVED');
      expect(received.coils.find((c) => c.coilId === cutCoil.id)!.status).toBe('RECEIVED');
      expect(received.coils.find((c) => c.coilId === pendingCoil.id)!.status).toBe('SENT');

      const cancelled = await postJson<CuttingOrderDto>(api, `/api/cutting/${orderId}/cancel`, {
        reason: 'La segunda bobina se necesita entera para otro pedido',
      });
      // Ya no queda nada SENT: pasa a un estado terminal, no a CANCELLED porque algo sí
      // se llegó a recibir (deriveCuttingOrderStatus, cutting-math.ts).
      expect(cancelled.status).toBe('RECEIVED');
      const pendingRow = cancelled.coils.find((c) => c.coilId === pendingCoil.id)!;
      expect(pendingRow.status).toBe('CANCELLED');
      expect(pendingRow.cancelledAt).not.toBeNull();
      expect(cancelled.coils.find((c) => c.coilId === cutCoil.id)!.status).toBe('RECEIVED');

      // La bobina pendiente vuelve a OPEN con su kilaje intacto: nunca tuvo movimiento
      // de kardex (D-050), así que no hay nada que revertir.
      const pendingAfter = await getJson<CoilDto>(api, `/api/coils/${pendingCoil.id}`);
      expect(pendingAfter.status).toBe('OPEN');
      expect(pendingAfter.availableKg).toBe('2000.000');

      // Repetir la cancelación ya no encuentra nada pendiente: la orden ya quedó en un
      // estado terminal (RECEIVED), así que el mensaje es el de "orden ya recibida por
      // completo", no el de "sin bobinas pendientes" (ese es para SENT/PARTIALLY_RECEIVED
      // sin filas SENT, que no es el caso acá).
      const twice = await postExpectingError(api, `/api/cutting/${orderId}/cancel`, {
        reason: 'Intento repetido de la misma cancelación',
      });
      expect(twice.status).toBe(400);
      expect(twice.message).toContain('pendiente');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          cuttingOrderId: orderId || undefined,
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierIds: [supplier.id],
          finish,
        });
      }
    }
  });
});

/**
 * Reparto de permisos de Fase 3: SUPERVISOR_PLANTA opera envío, recepción y cancelación
 * del corte tercerizado igual que partido y merma (D-046), pero vincular la factura del
 * servicio a la orden queda reservado a ADMINISTRADOR, mismo criterio que el landed cost
 * de bobinas (D-043): ambos mueven el costo promedio del inventario sin tope y sin poder
 * revertirlo una vez que el material se consume.
 */
test.describe('Fase 3 — roles (D-046, D-043)', () => {
  test.skip(skipWrites, 'Mueve kardex: en produccion solo con E2E_ALLOW_WRITES=1');

  test.beforeEach(() => {
    test.setTimeout(150_000);
  });

  test('un supervisor de planta envía, recibe y cancela un corte, pero no puede vincular la compra del servicio (D-046, D-043)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supervisor = await apiAs(baseURL!, await createUser(api, 'SUPERVISOR_PLANTA'));
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';
    let orderId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E de corte operada por planta',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
          {
            description: 'Bobina E2E que planta deja pendiente',
            weightKg: '2000',
            widthMm: '1000',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const motherA = coils.find((c) => c.weightKg === '5000.000')!;
      const motherB = coils.find((c) => c.weightKg === '2000.000')!;

      // RF-40: enviar a corte es trabajo de planta.
      const order = await postJson<CuttingOrderDto>(supervisor, '/api/cutting', {
        supplierId: supplier.id,
        coils: [
          {
            coilId: motherA.id,
            widthPlanMm: [
              { widthMm: '600', stripsCount: 1 },
              { widthMm: '560', stripsCount: 1 },
            ],
            expectedKerfLossMm: '60',
          },
          {
            coilId: motherB.id,
            widthPlanMm: [
              { widthMm: '500', stripsCount: 1 },
              { widthMm: '480', stripsCount: 1 },
            ],
            expectedKerfLossMm: '20',
          },
        ],
      });
      orderId = order.id;
      expect(order.status).toBe('SENT');

      // RF-41: y recibirlo.
      const received = await postJson<CuttingOrderDto>(
        supervisor,
        `/api/cutting/${orderId}/coils/${motherA.id}/receive`,
        {
          receivedWidthsMm: [
            { widthMm: '600', stripsCount: 1 },
            { widthMm: '560', stripsCount: 1 },
          ],
          receivedWeightKg: '5000',
          kerfLossMm: '0',
        },
      );
      expect(received.status).toBe('PARTIALLY_RECEIVED');
      expect(received.coils.find((c) => c.coilId === motherA.id)!.strips).toHaveLength(2);

      // RF-22: y cancelar lo que quedó pendiente.
      const cancelled = await postJson<CuttingOrderDto>(
        supervisor,
        `/api/cutting/${orderId}/cancel`,
        {
          reason: 'La bobina restante se usará en otro pedido',
        },
      );
      expect(cancelled.status).toBe('RECEIVED');
      expect((await getJson<CoilDto>(supervisor, `/api/coils/${motherB.id}`)).status).toBe('OPEN');

      // D-043/D-046: pero vincular la factura del servicio de corte a la orden es
      // exclusivo de ADMINISTRADOR, porque mueve el costo promedio del inventario.
      const denied = await postExpectingError(supervisor, '/api/purchases', {
        supplierId: supplier.id,
        businessLine: LINE,
        type: 'SERVICE',
        docType: 'FACTURA',
        series: 'F001',
        number: uniqueDocumentNumber(),
        issueDate: today(),
        currency: 'PEN',
        igvRate: '18',
        paymentTerms: 'CONTADO',
        serviceKind: 'CUTTING',
        relatedCuttingOrderId: orderId,
        items: [
          { description: 'Corte inventado desde planta', qty: '1', unit: 'ZZ', unitPrice: '500' },
        ],
      });
      expect(denied.status).toBe(403);
      expect(denied.message).toContain('administrador');

      // Nada de lo rechazado dejó rastro: los flejes conservan el costo de la madre.
      const strips = received.coils.find((c) => c.coilId === motherA.id)!.strips;
      for (const strip of strips) {
        const stripCoil = await getJson<CoilDto>(api, `/api/coils/${strip.id}`);
        expect(stripCoil.unitCostPerKg).toBe('4.0000');
      }
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          cuttingOrderId: orderId || undefined,
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierIds: [supplier.id],
          finish,
        });
      }
    }
  });
});
