import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import {
  adminApi,
  createFinish,
  getJson,
  postJson,
  type CreatedFinish,
  type CreatedSupplier,
} from '../helpers/api';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Fase 3b: revertir la recepción de una bobina de corte tercerizado, simétrico a RF-16
 * (revertir un partido). `POST /cutting/:cuttingOrderId/coils/:coilId/reverse` anula los
 * flejes (`kind=STRIP`) que creó esa recepción, revierte su movimiento `IN` de kardex,
 * revierte el `OUT` de la madre y deja la fila otra vez `SENT` (el envío sigue vivo:
 * D-050). Todo o nada, igual que RF-16: si algún fleje ya se movió, no revierte nada.
 *
 * Igual que `fase3.spec.ts`, mueve kardex, así que contra producción solo corre con
 * `E2E_ALLOW_WRITES=1` (D-024).
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

const LINE = 'drywall';

// ---------------------------------------------------------------------------
// DTOs mínimos del API que consumen los tests (el spec no importa @ayr/shared)
// ---------------------------------------------------------------------------

interface PurchaseDto {
  id: string;
  status: string;
}

interface CoilDto {
  id: string;
  code: string;
  kind: string;
  typeKey: string;
  status: string;
  weightKg: string;
  widthMm: string;
  parentCoilId: string | null;
  availableKg: string;
  unitCostPerKg: string;
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
  coilAvailableKg: string;
  status: string;
  receivedAt: string | null;
  receivedWidthsMm: WidthCountDto[] | null;
  receivedWeightKg: string | null;
  receivedKerfLossMm: string | null;
  receivedKerfLossKg: string | null;
  cancelledAt: string | null;
  revertedAt: string | null;
  strips: { id: string; code: string; widthMm: string; weightKg: string }[];
}

interface CuttingOrderDto {
  id: string;
  status: string;
  cancelledAt: string | null;
  coils: CuttingOrderCoilDto[];
}

interface StripStockRowDto {
  typeKey: string;
  widthMm: string;
  qtyKg: string;
  coilCount: number;
}

interface BalanceDto {
  itemId: string;
  qty: string;
  avgCost: string | null;
}

// ---------------------------------------------------------------------------
// Utilidades (copiadas de `fase3.spec.ts`: mismos patrones, sin exportarlas desde ahí)
// ---------------------------------------------------------------------------

function uniqueDocumentNumber(): string {
  return String(Date.now()).slice(-9);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function randomLetters(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Proveedor de prueba que sí presta servicio de corte tercerizado (RF-81). */
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

/** Compra de bobinas ya recibida: una bobina por línea, con su ingreso en el kardex. */
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

interface ApiError {
  status: number;
  message: string;
}

async function errorFrom(res: APIResponse, label: string): Promise<ApiError> {
  expect(res.ok(), `${label} debía fallar y devolvió ${res.status()}`).toBe(false);
  const body = (await res.json()) as { message?: string | string[] };
  const message = Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? '');
  return { status: res.status(), message };
}

async function postExpectingError(
  api: APIRequestContext,
  path: string,
  data?: unknown,
): Promise<ApiError> {
  const res = await api.post(path, data === undefined ? undefined : { data });
  return errorFrom(res, `POST ${path}`);
}

/**
 * Deja inerte en producción lo que el test creó (copiado de `fase3.spec.ts`): cancela
 * primero la orden de corte que haya quedado con bobinas pendientes, anula lo que
 * todavía admita anulación y desactiva proveedor y acabado. Nunca lanza: es limpieza de
 * `finally`.
 */
async function deactivateTrail(
  api: APIRequestContext,
  trail: {
    cuttingOrderId?: string;
    cuttingOrderIds?: string[];
    coilIds?: string[];
    purchaseIds?: string[];
    supplierIds?: string[];
    finish?: CreatedFinish;
  },
): Promise<void> {
  const cuttingOrderIds = [
    ...(trail.cuttingOrderId ? [trail.cuttingOrderId] : []),
    ...(trail.cuttingOrderIds ?? []),
  ];
  for (const cuttingOrderId of cuttingOrderIds) {
    await api
      .post(`/api/cutting/${cuttingOrderId}/cancel`, {
        data: { reason: 'Limpieza de prueba E2E' },
      })
      .catch(() => undefined);
  }
  for (const coilId of trail.coilIds ?? []) {
    await api
      .post(`/api/coils/${coilId}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
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
  }
}

test.describe('Fase 3b — revertir la recepción de un corte tercerizado (D-050, simétrico a RF-16)', () => {
  test.skip(skipWrites, 'Mueve kardex: en produccion solo con E2E_ALLOW_WRITES=1');

  test.beforeEach(() => {
    test.setTimeout(150_000);
  });

  test('revertir una recepción total devuelve el saldo a la madre, cancela los flejes y deja la orden lista para cancelarse (flujo feliz)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';
    let orderId = '';
    let motherId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E enviada a corte para revertir su recepción',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const mother = coils[0]!;
      motherId = mother.id;

      // --- Enviar a corte y recibirla por completo ---
      const order = await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: supplier.id,
        notes: 'Orden E2E Fase 3b — reversa de recepción total',
        coils: [
          {
            coilId: mother.id,
            widthPlanMm: [
              { widthMm: '600', stripsCount: 1 },
              { widthMm: '560', stripsCount: 1 },
            ],
            expectedKerfLossMm: '60',
          },
        ],
      });
      orderId = order.id;
      expect(order.status).toBe('SENT');

      const received = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/receive`,
        {
          receivedWidthsMm: [
            { widthMm: '600', stripsCount: 1 },
            { widthMm: '560', stripsCount: 1 },
          ],
          receivedWeightKg: '5000',
          kerfLossMm: '0',
        },
      );
      // Recepción total (RF-41): no queda nada pendiente en la madre.
      expect(received.status).toBe('RECEIVED');
      const rowReceived = received.coils.find((c) => c.coilId === mother.id)!;
      expect(rowReceived.status).toBe('RECEIVED');
      expect(rowReceived.strips).toHaveLength(2);
      const strip600 = rowReceived.strips.find((s) => s.widthMm === '600.00')!;
      const strip560 = rowReceived.strips.find((s) => s.widthMm === '560.00')!;
      expect(strip600).toBeDefined();
      expect(strip560).toBeDefined();

      // La madre se cierra: no le quedó nada (RF-19).
      const motherClosed = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherClosed).toMatchObject({ status: 'CLOSED', availableKg: '0.000' });
      expect((await coilBalance(api, mother.id)).qty).toBe('0.000');

      // Los flejes ya están en `/cutting/strips` (RF-42), listos para venderse.
      const stripsBefore = await getJson<StripStockRowDto[]>(
        api,
        `/api/cutting/strips?businessLine=${LINE}`,
      );
      expect(
        stripsBefore.some((r) => r.typeKey === mother.typeKey && r.widthMm === '600.00'),
        'El fleje de 600 mm debía aparecer en /cutting/strips antes de revertir',
      ).toBe(true);
      expect(
        stripsBefore.some((r) => r.typeKey === mother.typeKey && r.widthMm === '560.00'),
        'El fleje de 560 mm debía aparecer en /cutting/strips antes de revertir',
      ).toBe(true);

      // --- Fase 3b: revertir la recepción ---
      const reverted = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/reverse`,
        { reason: 'Recepción registrada por error: se revierte en la prueba E2E' },
      );
      const rowReverted = reverted.coils.find((c) => c.coilId === mother.id)!;
      expect(rowReverted).toMatchObject({
        status: 'SENT',
        receivedAt: null,
        receivedWidthsMm: null,
        receivedWeightKg: null,
        receivedKerfLossMm: null,
        receivedKerfLossKg: null,
        cancelledAt: null,
        // La madre vuelve a estar en poder del tercero, con el ancho de la orden que
        // sigue viva.
        coilAvailableKg: '5000.000',
      });
      expect(rowReverted.revertedAt).not.toBeNull();
      expect(reverted.status).toBe('SENT');

      // La madre recupera su saldo original en kg, en poder del tercero (D-050): el
      // envío sigue vivo, no queda "disponible" en planta hasta que se reciba de nuevo.
      const motherAfterReverse = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterReverse).toMatchObject({ status: 'IN_THIRD_PARTY', availableKg: '5000.000' });
      const motherBalanceAfterReverse = await coilBalance(api, mother.id);
      expect(motherBalanceAfterReverse.qty).toBe('5000.000');
      expect(motherBalanceAfterReverse.avgCost).toBe('4.0000');

      // Los flejes quedan cancelados y sin saldo: desaparecen del stock de flejes.
      for (const strip of [strip600, strip560]) {
        const stripAfter = await getJson<CoilDto>(api, `/api/coils/${strip.id}`);
        expect(stripAfter).toMatchObject({ status: 'CANCELLED', availableKg: '0.000' });
      }
      const stripsAfter = await getJson<StripStockRowDto[]>(
        api,
        `/api/cutting/strips?businessLine=${LINE}`,
      );
      expect(
        stripsAfter.some((r) => r.typeKey === mother.typeKey && r.widthMm === '600.00'),
        'El fleje de 600 mm debía desaparecer de /cutting/strips tras revertir',
      ).toBe(false);
      expect(
        stripsAfter.some((r) => r.typeKey === mother.typeKey && r.widthMm === '560.00'),
        'El fleje de 560 mm debía desaparecer de /cutting/strips tras revertir',
      ).toBe(false);

      // --- La fila volvió a SENT: se puede cancelar el envío pendiente (RF-22) ---
      const cancelled = await postJson<CuttingOrderDto>(api, `/api/cutting/${orderId}/cancel`, {
        reason: 'Ya no hace falta cortar esta bobina (prueba E2E)',
      });
      expect(cancelled.status).toBe('CANCELLED');
      const rowCancelled = cancelled.coils.find((c) => c.coilId === mother.id)!;
      expect(rowCancelled.status).toBe('CANCELLED');
      expect(rowCancelled.cancelledAt).not.toBeNull();

      // D-050: cancelar un SENT nunca tocó kardex, así que la madre vuelve a OPEN con
      // el mismo kilaje que recuperó al revertir.
      const motherAfterCancel = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterCancel).toMatchObject({ status: 'OPEN', availableKg: '5000.000' });

      // --- Y ahora sí, sin movimientos posteriores al ingreso inicial, se puede anular
      // la bobina madre entera (RF-21): la reversa dejó el par OUT/IN sin saldo vivo. ---
      const motherCancelled = await postJson<CoilDto>(api, `/api/coils/${mother.id}/cancel`, {
        reason: 'Bobina madre ya no se usa (prueba E2E)',
      });
      expect(motherCancelled.status).toBe('CANCELLED');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          cuttingOrderId: orderId || undefined,
          coilIds: motherId ? [motherId] : [],
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierIds: [supplier.id],
          finish,
        });
      }
    }
  });

  test('la reversa se bloquea con 400 (no 500) si uno de los flejes ya se movió, por ejemplo con una merma', async ({
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
            description: 'Bobina E2E cuyo fleje se consume antes de revertir',
            weightKg: '2000',
            widthMm: '1000',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const mother = coils[0]!;

      const order = await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: supplier.id,
        coils: [
          {
            coilId: mother.id,
            widthPlanMm: [{ widthMm: '480', stripsCount: 2 }],
            expectedKerfLossMm: '20',
          },
        ],
      });
      orderId = order.id;

      const received = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/receive`,
        {
          receivedWidthsMm: [{ widthMm: '480', stripsCount: 2 }],
          receivedWeightKg: '2000',
          kerfLossMm: '0',
        },
      );
      expect(received.status).toBe('RECEIVED');
      const rowReceived = received.coils.find((c) => c.coilId === mother.id)!;
      expect(rowReceived.strips).toHaveLength(2);
      const [stripA, stripB] = rowReceived.strips;

      // Se consume uno de los flejes con una merma (RF-17): ya no se puede devolver ese
      // peso a la madre sin inventariar kilos que ya no existen.
      const scrapped = await postJson<CoilDto>(api, `/api/coils/${stripA!.id}/scrap`, {
        qtyKg: '50',
        reason: 'Merma E2E para bloquear la reversa',
      });
      expect(scrapped.status).toBe('OPEN');

      const blocked = await postExpectingError(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/reverse`,
        { reason: 'Se intenta revertir pese a la merma (prueba E2E)' },
      );
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(stripA!.code);
      expect(blocked.message).toContain('movimientos posteriores');
      expect(blocked.message).toContain('SCRAP');

      // Nada quedó a medias: ni la orden ni la madre ni el fleje B se tocaron.
      const rowStillReceived = (await getJson<CuttingOrderDto>(api, `/api/cutting/${orderId}`))
        .coils.find((c) => c.coilId === mother.id)!;
      expect(rowStillReceived.status).toBe('RECEIVED');
      const motherStillClosed = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherStillClosed.status).toBe('CLOSED');
      const stripBAfter = await getJson<CoilDto>(api, `/api/coils/${stripB!.id}`);
      expect(stripBAfter.status).toBe('OPEN');
      expect(stripBAfter.availableKg).toBe(stripB!.weightKg);
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

  test('revertir una recepción parcial deja el envío vivo: la fila vuelve a SENT y la madre a IN_THIRD_PARTY, ni OPEN ni CLOSED', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';
    let orderId = '';
    let motherId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E con recepción parcial que luego se revierte',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const mother = coils[0]!;
      motherId = mother.id;

      const order = await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: supplier.id,
        coils: [
          {
            coilId: mother.id,
            widthPlanMm: [
              { widthMm: '600', stripsCount: 1 },
              { widthMm: '560', stripsCount: 1 },
            ],
            expectedKerfLossMm: '60',
          },
        ],
      });
      orderId = order.id;

      // Recepción parcial: se declaran menos kilos que el saldo disponible de la madre
      // (3 000 de 5 000), así que a la madre le queda saldo y vuelve a OPEN, no CLOSED.
      const received = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/receive`,
        {
          receivedWidthsMm: [
            { widthMm: '600', stripsCount: 1 },
            { widthMm: '560', stripsCount: 1 },
          ],
          receivedWeightKg: '3000',
          kerfLossMm: '0',
        },
      );
      expect(received.status).toBe('RECEIVED');
      const motherAfterReceive = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterReceive).toMatchObject({ status: 'OPEN', availableKg: '2000.000' });

      // --- Revertir esa recepción parcial ---
      const reverted = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/reverse`,
        { reason: 'Recepción parcial registrada por error (prueba E2E)' },
      );
      const rowReverted = reverted.coils.find((c) => c.coilId === mother.id)!;
      // El envío sigue vivo: la fila vuelve a SENT, no a un estado terminal.
      expect(rowReverted.status).toBe('SENT');
      expect(reverted.status).toBe('SENT');

      // La madre vuelve a estar en poder del tercero con TODO su saldo original (los
      // 2 000 que le quedaban más los 3 000 que se le devuelven) — nunca OPEN ni CLOSED,
      // que serían estados de "disponible en planta" que no aplican mientras el envío
      // siga vivo.
      const motherAfterReverse = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterReverse.status).toBe('IN_THIRD_PARTY');
      expect(motherAfterReverse.status).not.toBe('OPEN');
      expect(motherAfterReverse.status).not.toBe('CLOSED');
      expect(motherAfterReverse.availableKg).toBe('5000.000');

      // Limpieza dentro del propio test: con la fila SENT de nuevo, se puede cancelar el
      // envío y anular la bobina, dejando todo en un estado terminal sin depender de
      // `deactivateTrail` (que solo corre contra producción).
      const cancelled = await postJson<CuttingOrderDto>(api, `/api/cutting/${orderId}/cancel`, {
        reason: 'Cierre de la prueba E2E de recepción parcial',
      });
      expect(cancelled.status).toBe('CANCELLED');
      const motherAfterCancel = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterCancel).toMatchObject({ status: 'OPEN', availableKg: '5000.000' });
      const motherCancelled = await postJson<CoilDto>(api, `/api/coils/${mother.id}/cancel`, {
        reason: 'Cierre de la prueba E2E de recepción parcial',
      });
      expect(motherCancelled.status).toBe('CANCELLED');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          cuttingOrderId: orderId || undefined,
          coilIds: motherId ? [motherId] : [],
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierIds: [supplier.id],
          finish,
        });
      }
    }
  });

  test('la reversa se bloquea con 400 si la madre ya se reenvió a otra orden de corte tercerizado (guardrail propio de D-050)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';
    let firstOrderId = '';
    let secondOrderId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E que se reenvía a un segundo corte antes de revertir el primero',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const mother = coils[0]!;

      // --- Primer envío y recepción parcial: a la madre le queda saldo (D-050, RF-19). ---
      const firstOrder = await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: supplier.id,
        coils: [
          {
            coilId: mother.id,
            widthPlanMm: [
              { widthMm: '600', stripsCount: 1 },
              { widthMm: '560', stripsCount: 1 },
            ],
            expectedKerfLossMm: '60',
          },
        ],
      });
      firstOrderId = firstOrder.id;

      const firstReceived = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${firstOrderId}/coils/${mother.id}/receive`,
        {
          receivedWidthsMm: [
            { widthMm: '600', stripsCount: 1 },
            { widthMm: '560', stripsCount: 1 },
          ],
          receivedWeightKg: '3000',
          kerfLossMm: '0',
        },
      );
      expect(firstReceived.status).toBe('RECEIVED');
      const motherAfterFirstReceive = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      // OPEN con saldo: send() solo acepta bobinas OPEN, así que esto es lo que habilita
      // reenviarla sin haber revertido la primera recepción.
      expect(motherAfterFirstReceive).toMatchObject({ status: 'OPEN', availableKg: '2000.000' });

      // --- Se reenvía la misma madre a una SEGUNDA orden con lo que le quedó (D-050: el
      // envío no deja rastro de kardex, así que nada impide reenviarla). ---
      const secondOrder = await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: supplier.id,
        notes: 'Segundo envío E2E de la misma madre',
        coils: [
          {
            coilId: mother.id,
            widthPlanMm: [{ widthMm: '400', stripsCount: 1 }],
            expectedKerfLossMm: '0',
          },
        ],
      });
      secondOrderId = secondOrder.id;
      const motherAfterSecondSend = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterSecondSend).toMatchObject({
        status: 'IN_THIRD_PARTY',
        availableKg: '2000.000',
      });

      // --- Revertir la PRIMERA recepción mientras la madre sigue en el tercero por el
      // SEGUNDO envío: el guardrail propio de esta reversa (D-050, RF-16 no lo necesita
      // porque una bobina hija de un partido nunca puede "reenviarse" a otro lado) lo
      // bloquea con 400, no con un 200 que dejaría el saldo mal repartido entre dos
      // envíos vivos. ---
      const blocked = await postExpectingError(
        api,
        `/api/cutting/${firstOrderId}/coils/${mother.id}/reverse`,
        { reason: 'Se intenta revertir pese al segundo envío (prueba E2E)' },
      );
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(mother.code);
      expect(blocked.message).toContain('enviada a otra orden de corte');

      // Nada quedó a medias: la primera fila sigue RECEIVED, la madre sigue en el
      // tercero por el segundo envío con el mismo saldo.
      const firstRowStill = (
        await getJson<CuttingOrderDto>(api, `/api/cutting/${firstOrderId}`)
      ).coils.find((c) => c.coilId === mother.id)!;
      expect(firstRowStill.status).toBe('RECEIVED');
      const secondRowStill = (
        await getJson<CuttingOrderDto>(api, `/api/cutting/${secondOrderId}`)
      ).coils.find((c) => c.coilId === mother.id)!;
      expect(secondRowStill.status).toBe('SENT');
      const motherStillInThirdParty = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherStillInThirdParty).toMatchObject({
        status: 'IN_THIRD_PARTY',
        availableKg: '2000.000',
      });
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          cuttingOrderIds: [secondOrderId, firstOrderId].filter(Boolean),
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierIds: [supplier.id],
          finish,
        });
      }
    }
  });

  test('la reversa se bloquea con 400 si la madre tuvo un movimiento de kardex posterior a la recepción, por ejemplo un partido local', async ({
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
            description: 'Bobina E2E que se parte localmente antes de revertir su corte',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const mother = coils[0]!;

      const order = await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: supplier.id,
        coils: [
          {
            coilId: mother.id,
            widthPlanMm: [
              { widthMm: '600', stripsCount: 1 },
              { widthMm: '560', stripsCount: 1 },
            ],
            expectedKerfLossMm: '60',
          },
        ],
      });
      orderId = order.id;

      // Recepción parcial: a la madre le queda saldo y vuelve a OPEN (D-050, RF-19).
      const received = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/receive`,
        {
          receivedWidthsMm: [
            { widthMm: '600', stripsCount: 1 },
            { widthMm: '560', stripsCount: 1 },
          ],
          receivedWeightKg: '3000',
          kerfLossMm: '0',
        },
      );
      expect(received.status).toBe('RECEIVED');
      const motherAfterReceive = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterReceive).toMatchObject({ status: 'OPEN', availableKg: '2000.000' });

      // Se parte localmente lo que le quedó a la madre (RF-15): eso es un movimiento de
      // kardex posterior a la salida de la recepción de corte que se quiere revertir.
      // Los anchos cubren 1160 de los 1220 mm (95%), por encima del piso de rendimiento
      // del partido (RF-15): con una sola tira angosta el partido se rechazaría antes de
      // llegar a la reversa que se quiere probar acá.
      const splitChildren = await postJson<CoilDto[]>(api, `/api/coils/${mother.id}/split`, {
        splitWeightKg: '500',
        kerfLossMm: '0',
        children: [
          { widthMm: '600', count: 1 },
          { widthMm: '560', count: 1 },
        ],
      });
      expect(splitChildren).toHaveLength(2);

      const blocked = await postExpectingError(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/reverse`,
        { reason: 'Se intenta revertir pese al partido posterior (prueba E2E)' },
      );
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(mother.code);
      expect(blocked.message).toContain('ya tuvo movimientos posteriores a esta recepción');
      expect(blocked.message).toContain('SPLIT');

      // Nada quedó a medias: la fila sigue RECEIVED, la madre sigue OPEN con el saldo
      // que le quedó después del partido, y la hija del partido sigue viva.
      const rowStill = (await getJson<CuttingOrderDto>(api, `/api/cutting/${orderId}`)).coils.find(
        (c) => c.coilId === mother.id,
      )!;
      expect(rowStill.status).toBe('RECEIVED');
      const motherStill = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherStill).toMatchObject({ status: 'OPEN', availableKg: '1500.000' });
      for (const child of splitChildren) {
        const childAfter = await getJson<CoilDto>(api, `/api/coils/${child.id}`);
        expect(childAfter.status).toBe('OPEN');
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

  test('recibir, revertir y volver a recibir la misma bobina: la segunda reversa solo cancela los flejes de la segunda generación, sin mezclarlos con los ya cancelados de la primera', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createCuttingSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';
    let orderId = '';
    let motherId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E con dos ciclos de recepción/reversa sobre la misma fila',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const mother = coils[0]!;
      motherId = mother.id;

      const order = await postJson<CuttingOrderDto>(api, '/api/cutting', {
        supplierId: supplier.id,
        coils: [
          {
            coilId: mother.id,
            widthPlanMm: [
              { widthMm: '600', stripsCount: 1 },
              { widthMm: '560', stripsCount: 1 },
            ],
            expectedKerfLossMm: '60',
          },
        ],
      });
      orderId = order.id;

      // --- Primera generación: recibir y revertir ---
      const received1 = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/receive`,
        {
          receivedWidthsMm: [
            { widthMm: '600', stripsCount: 1 },
            { widthMm: '560', stripsCount: 1 },
          ],
          receivedWeightKg: '2000',
          kerfLossMm: '0',
        },
      );
      const row1 = received1.coils.find((c) => c.coilId === mother.id)!;
      expect(row1.strips).toHaveLength(2);
      const gen1Strips = row1.strips;
      const gen1Ids = new Set(gen1Strips.map((s) => s.id));

      const reverted1 = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/reverse`,
        { reason: 'Primera reversa del ciclo doble (prueba E2E)' },
      );
      const rowAfterRevert1 = reverted1.coils.find((c) => c.coilId === mother.id)!;
      expect(rowAfterRevert1.status).toBe('SENT');
      // El fix de `findOne()` (D-050/Fase 3b) excluye los flejes CANCELLED: la fila
      // recién revertida no debe listar los de la primera generación.
      expect(rowAfterRevert1.strips).toHaveLength(0);
      for (const strip of gen1Strips) {
        const stripCoil = await getJson<CoilDto>(api, `/api/coils/${strip.id}`);
        expect(stripCoil).toMatchObject({ status: 'CANCELLED', availableKg: '0.000' });
      }
      const motherAfterRevert1 = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterRevert1).toMatchObject({
        status: 'IN_THIRD_PARTY',
        availableKg: '5000.000',
      });

      // --- Segunda generación: recibir de nuevo la MISMA fila, con otro reparto de
      // kilos, y revertirla también. Antes del fix, `reverse()` armaba la lista de
      // flejes a partir de `cuttingOrderCoilId` sin filtrar estado, así que mezclaba
      // los ya `CANCELLED` de la primera generación con los vivos de esta. ---
      const received2 = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/receive`,
        {
          receivedWidthsMm: [
            { widthMm: '600', stripsCount: 1 },
            { widthMm: '560', stripsCount: 1 },
          ],
          receivedWeightKg: '4000',
          kerfLossMm: '0',
        },
      );
      const row2 = received2.coils.find((c) => c.coilId === mother.id)!;
      // Regresión del bug: sin el fix, esto listaría 4 flejes (2 CANCELLED de la
      // primera generación + 2 vivos de esta), no 2.
      expect(row2.strips).toHaveLength(2);
      const gen2Strips = row2.strips;
      for (const strip of gen2Strips) {
        expect(gen1Ids.has(strip.id), 'La segunda recepción no debe reusar flejes de la primera').toBe(
          false,
        );
      }
      const motherAfterReceive2 = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterReceive2).toMatchObject({ status: 'OPEN', availableKg: '1000.000' });

      const reverted2 = await postJson<CuttingOrderDto>(
        api,
        `/api/cutting/${orderId}/coils/${mother.id}/reverse`,
        { reason: 'Segunda reversa del ciclo doble (prueba E2E)' },
      );
      const rowAfterRevert2 = reverted2.coils.find((c) => c.coilId === mother.id)!;
      expect(rowAfterRevert2.status).toBe('SENT');
      // Sigue sin mezclar: ninguna generación aparece ya que ambas están CANCELLED.
      expect(rowAfterRevert2.strips).toHaveLength(0);

      // Los flejes de la primera generación siguen exactamente como quedaron tras la
      // primera reversa: la segunda reversa no debió tocarlos de nuevo.
      for (const strip of gen1Strips) {
        const stripCoil = await getJson<CoilDto>(api, `/api/coils/${strip.id}`);
        expect(stripCoil).toMatchObject({ status: 'CANCELLED', availableKg: '0.000' });
      }
      // Los de la segunda generación quedan cancelados por esta segunda reversa.
      for (const strip of gen2Strips) {
        const stripCoil = await getJson<CoilDto>(api, `/api/coils/${strip.id}`);
        expect(stripCoil).toMatchObject({ status: 'CANCELLED', availableKg: '0.000' });
      }

      // El saldo final de la madre es el peso completo original: ni duplicado ni
      // perdido en los dos ciclos de recepción/reversa.
      const motherAfterRevert2 = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfterRevert2).toMatchObject({
        status: 'IN_THIRD_PARTY',
        availableKg: '5000.000',
      });
      const motherBalance = await coilBalance(api, mother.id);
      expect(motherBalance.qty).toBe('5000.000');
      expect(motherBalance.avgCost).toBe('4.0000');

      // Limpieza dentro del propio test: la fila volvió a SENT, se puede cerrar todo.
      const cancelled = await postJson<CuttingOrderDto>(api, `/api/cutting/${orderId}/cancel`, {
        reason: 'Cierre de la prueba E2E del ciclo doble',
      });
      expect(cancelled.status).toBe('CANCELLED');
      const motherCancelled = await postJson<CoilDto>(api, `/api/coils/${mother.id}/cancel`, {
        reason: 'Cierre de la prueba E2E del ciclo doble',
      });
      expect(motherCancelled.status).toBe('CANCELLED');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          cuttingOrderId: orderId || undefined,
          coilIds: motherId ? [motherId] : [],
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierIds: [supplier.id],
          finish,
        });
      }
    }
  });
});
