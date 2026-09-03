import { randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import {
  adminApi,
  createFinish,
  createSupplier,
  createUser,
  getJson,
  postJson,
  type CreatedFinish,
  type CreatedUser,
} from '../helpers/api';
import { loginAndSetPassword } from '../helpers/ui';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Sesión M-2: anular un pago a proveedor, el hueco que D-039 dejó pendiente ("anular un
 * pago se resuelve en Fase 2b junto con el resto de anulaciones", nunca construido).
 *
 * `POST /purchases/:id/payments/:paymentId/reverse` marca el pago `reversedAt` (nunca lo
 * borra, append-only igual que RF-16/D-052) y el saldo vuelve a incluirlo, porque
 * `purchaseBalance` filtra los pagos anulados. El guardrail "aguas abajo" es el mismo
 * que ya existía en `cancel()`, ahora correcto: una compra no se puede anular mientras
 * tenga un pago VIGENTE (antes contaba cualquier pago, vivo o no, así que una compra
 * pagada quedaba bloqueada para siempre).
 *
 * Escribe, así que contra producción solo corre con `E2E_ALLOW_WRITES=1` (D-024).
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';
/** Contraseña definitiva de los usuarios efímeros que solo se usan por API. */
const ROLE_PASSWORD = 'ClaveRolE2E-2026';

// ---------------------------------------------------------------------------
// DTOs mínimos del API que consumen los tests
// ---------------------------------------------------------------------------

interface PaymentDto {
  id: string;
  amount: string;
  currency: string;
  reference: string | null;
  reversedAt: string | null;
}

interface PurchaseDto {
  id: string;
  documentLabel: string;
  status: string;
  currency: string;
  total: string;
  paidAmount: string;
  balance: string;
  payments: PaymentDto[];
}

interface StatementDto {
  totalBalancePen: string;
  purchases: { documentLabel: string; balance: string; balancePen: string }[];
}

interface CoilDto {
  id: string;
  code: string;
  status: string;
  weightKg: string;
  availableKg: string;
}

interface MovementDto {
  id: string;
  itemId: string;
  type: string;
  qty: string;
  balanceQty: string | null;
  balanceAvgCost: string | null;
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

function uniqueDocumentNumber(): string {
  return String(Date.now()).slice(-9);
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

/** Compra `SERVICE` sencilla: sin bobinas ni kardex, solo cuenta por pagar (D-030). */
async function expensePurchase(
  api: APIRequestContext,
  supplierId: string,
  amount = '10000',
  currency: 'PEN' | 'USD' = 'PEN',
): Promise<PurchaseDto> {
  return postJson<PurchaseDto>(api, '/api/purchases', {
    supplierId,
    businessLine: 'services',
    type: 'SERVICE',
    docType: 'FACTURA',
    series: 'F001',
    number: uniqueDocumentNumber(),
    issueDate: new Date().toISOString().slice(0, 10),
    currency,
    igvRate: '18',
    paymentTerms: 'CONTADO',
    serviceKind: 'FREIGHT',
    items: [{ description: 'Servicio E2E M-2', qty: '1', unit: 'ZZ', unitPrice: amount }],
  });
}

/**
 * Contexto de API autenticado como un usuario recién creado. El primer ingreso obliga a
 * cambiar la contraseña temporal (RF-01); la sesión actual sobrevive al cambio. Copiado
 * de `fase2b.spec.ts`, mismo patrón para probar el guardrail de rol.
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

/**
 * Limpieza: anula cualquier pago que siga vigente en la compra, para que `cancel()` (que
 * exige cero pagos vigentes) pueda anularla después. Nunca lanza.
 */
async function reverseLivePayments(api: APIRequestContext, purchaseId: string): Promise<void> {
  const purchase = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`).catch(
    () => null,
  );
  for (const payment of purchase?.payments ?? []) {
    if (payment.reversedAt) continue;
    await api
      .post(`/api/purchases/${purchaseId}/payments/${payment.id}/reverse`, {
        data: { reason: 'Limpieza de prueba E2E' },
      })
      .catch(() => undefined);
  }
}

/** Deja inerte en producción lo que el test creó. Nunca lanza: es limpieza de `finally`. */
async function deactivateTrail(
  api: APIRequestContext,
  trail: { purchaseIds?: string[]; supplierId?: string; finish?: CreatedFinish },
): Promise<void> {
  for (const purchaseId of trail.purchaseIds ?? []) {
    // Un pago vigente bloquea `cancel()` (justo el guardrail que este spec prueba): se
    // anula primero para que la compra quede anulable, igual que haría un operador real.
    await reverseLivePayments(api, purchaseId);
    await api
      .post(`/api/purchases/${purchaseId}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
      .catch(() => undefined);
  }
  if (trail.supplierId) {
    await api
      .patch(`/api/suppliers/${trail.supplierId}`, { data: { isActive: false } })
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

test.describe('Sesión M-2 — anular un pago a proveedor (cierra D-039)', () => {
  test.skip(skipWrites, 'Crea datos: en produccion solo con E2E_ALLOW_WRITES=1');

  test.beforeEach(() => {
    test.setTimeout(90_000);
  });

  test('pagar → anular el pago desde la UI → el saldo vuelve al total → anular el comprobante', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    await loginAndSetPassword(page, admin, ADMIN_PASSWORD);

    const supplier = await createSupplier(api);
    let purchaseId = '';

    try {
      // 10 000 + 18 % = 11 800 de total.
      const purchase = await expensePurchase(api, supplier.id, '10000');
      purchaseId = purchase.id;
      expect(purchase.total).toBe('11800.0000');
      expect(purchase.balance).toBe('11800.0000');

      await page.goto(`/compras/${purchaseId}`);
      await expect(
        page.getByRole('heading', { name: `Factura ${purchase.documentLabel}` }),
      ).toBeVisible();

      // --- Registrar un pago parcial ---
      await page.getByRole('button', { name: 'Registrar pago' }).click();
      await page.getByLabel('Monto').fill('5000');
      await page.getByLabel('Referencia').fill('E2E-M2-PAGO');
      await page.getByRole('button', { name: 'Guardar pago' }).click();
      await expect(page.getByText('Pago registrado')).toBeVisible();
      // Saldo = 11 800 − 5 000 = 6 800.
      await expect(page.getByText('S/ 6,800.00')).toBeVisible();

      const withPayment = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`);
      expect(withPayment.payments).toHaveLength(1);
      const paymentId = withPayment.payments[0]!.id;
      expect(withPayment.payments[0]?.reversedAt).toBeNull();

      // --- Anular el comprobante está bloqueado mientras el pago siga vigente ---
      const blockedCancel = await postExpectingError(api, `/api/purchases/${purchaseId}/cancel`, {
        reason: 'Intento de anular con un pago vivo (prueba E2E)',
      });
      expect(blockedCancel.status).toBe(400);
      expect(blockedCancel.message).toContain('pagos registrados');

      // --- Anular el pago desde la UI (botón nuevo, mismo ReasonDialog de siempre) ---
      await page
        .getByRole('row')
        .filter({ hasText: 'E2E-M2-PAGO' })
        .getByRole('button', { name: 'Anular pago' })
        .click();
      await page.getByLabel('Motivo').fill('Pago registrado por error (prueba E2E)');
      await page.getByRole('button', { name: 'Sí, anular' }).click();
      await expect(
        page.getByText('Pago anulado: el monto vuelve a formar parte del saldo pendiente'),
      ).toBeVisible();

      // El saldo vuelve a ser el total completo.
      await expect(page.getByText('S/ 11,800.00').first()).toBeVisible();
      await expect(page.getByRole('row').filter({ hasText: 'E2E-M2-PAGO' })).toContainText(
        'Anulado',
      );

      const afterReverse = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`);
      expect(afterReverse.balance).toBe('11800.0000');
      expect(afterReverse.paidAmount).toBe('0.0000');
      // Append-only: la fila sigue ahí, marcada, no desaparece (§3.2, RF-95).
      expect(afterReverse.payments).toHaveLength(1);
      expect(afterReverse.payments[0]).toMatchObject({
        id: paymentId,
        reversedAt: expect.any(String),
      });

      // --- Con el pago revertido, el comprobante ya se puede anular ---
      // `exact` importa: sin él, este selector también matchea "Anular pago" de la tabla.
      await page.getByRole('button', { name: 'Anular', exact: true }).click();
      await page.getByLabel('Motivo').fill('Cierre de la prueba E2E');
      await page.getByRole('button', { name: 'Sí, anular' }).click();
      await expect(page.getByText('Compra anulada')).toBeVisible();

      const cancelled = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`);
      expect(cancelled.status).toBe('CANCELLED');
    } finally {
      if (isProduction) {
        // La compra ya quedó anulada por el propio test; solo falta el proveedor.
        await deactivateTrail(api, { supplierId: supplier.id });
      }
    }
  });

  test('anular el comprobante se bloquea con 400 mientras un pago siga vigente (guardrail aguas abajo), y anular el mismo pago dos veces se bloquea con 409', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    let purchaseId = '';

    try {
      const purchase = await expensePurchase(api, supplier.id, '4000');
      purchaseId = purchase.id;

      const paid = await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/payments`, {
        date: new Date().toISOString().slice(0, 10),
        amount: '4720',
        currency: 'PEN',
        method: 'TRANSFER',
        reference: 'E2E-M2-GUARDRAIL',
      });
      expect(paid.balance).toBe('0.0000');
      const paymentId = paid.payments[0]!.id;

      // --- Guardrail 1: la compra no se anula mientras el pago esté vigente ---
      const blockedCancel = await postExpectingError(api, `/api/purchases/${purchaseId}/cancel`, {
        reason: 'Intento de anular con el pago vivo (prueba E2E)',
      });
      expect(blockedCancel.status).toBe(400);
      expect(blockedCancel.message).toContain('pagos registrados');

      // La compra sigue intacta: nada quedó a medias.
      const stillDraft = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`);
      expect(stillDraft.status).not.toBe('CANCELLED');
      expect(stillDraft.balance).toBe('0.0000');

      // --- Se revierte el pago: ahora sí se puede anular la compra ---
      const reversed = await postJson<PurchaseDto>(
        api,
        `/api/purchases/${purchaseId}/payments/${paymentId}/reverse`,
        { reason: 'Se revierte para destrabar la compra (prueba E2E)' },
      );
      expect(reversed.balance).toBe('4720.0000');

      // --- Guardrail 2: ese mismo pago no se puede anular dos veces (idempotencia) ---
      const blockedDouble = await postExpectingError(
        api,
        `/api/purchases/${purchaseId}/payments/${paymentId}/reverse`,
        { reason: 'Segundo intento de anular el mismo pago (prueba E2E)' },
      );
      expect(blockedDouble.status).toBe(409);
      expect(blockedDouble.message).toContain('ya fue anulado');

      // Nada se movió de más: el saldo sigue siendo el mismo tras el intento bloqueado.
      const stillReversed = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`);
      expect(stillReversed.balance).toBe('4720.0000');
      expect(stillReversed.payments).toHaveLength(1);

      // --- Y ahora sí, sin pagos vigentes, la compra se anula ---
      const cancelled = await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/cancel`, {
        reason: 'Cierre de la prueba E2E',
      });
      expect(cancelled.status).toBe('CANCELLED');
      purchaseId = ''; // ya quedó anulada por el propio test
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
        });
      }
    }
  });

  test('con varios pagos parciales, anular uno del medio devuelve exactamente su monto al saldo (no depende del orden)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    let purchaseId = '';

    try {
      // 10 000 + 18 % = 11 800.
      const purchase = await expensePurchase(api, supplier.id, '10000');
      purchaseId = purchase.id;

      await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/payments`, {
        date: new Date().toISOString().slice(0, 10),
        amount: '3000',
        currency: 'PEN',
        method: 'TRANSFER',
        reference: 'E2E-M2-A',
      });
      await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/payments`, {
        date: new Date().toISOString().slice(0, 10),
        amount: '4000',
        currency: 'PEN',
        method: 'TRANSFER',
        reference: 'E2E-M2-B',
      });
      const afterThree = await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/payments`, {
        date: new Date().toISOString().slice(0, 10),
        amount: '2000',
        currency: 'PEN',
        method: 'TRANSFER',
        reference: 'E2E-M2-C',
      });
      // 11 800 − 3 000 − 4 000 − 2 000 = 2 800.
      expect(afterThree.balance).toBe('2800.0000');
      expect(afterThree.payments).toHaveLength(3);

      // Se anula el del medio (B), ni el primero ni el último.
      const paymentB = afterThree.payments.find((p) => p.reference === 'E2E-M2-B')!;
      const afterReverseB = await postJson<PurchaseDto>(
        api,
        `/api/purchases/${purchaseId}/payments/${paymentB.id}/reverse`,
        { reason: 'Se anula el pago del medio (prueba E2E)' },
      );

      // Solo A y C siguen vigentes: 11 800 − 3 000 − 2 000 = 6 800. El saldo no depende de
      // qué pago se anuló ni del orden en que se registraron.
      expect(afterReverseB.balance).toBe('6800.0000');
      expect(afterReverseB.paidAmount).toBe('5000.0000');

      const byRef = new Map(afterReverseB.payments.map((p) => [p.reference, p.reversedAt]));
      expect(byRef.get('E2E-M2-A')).toBeNull();
      expect(byRef.get('E2E-M2-B')).toEqual(expect.any(String));
      expect(byRef.get('E2E-M2-C')).toBeNull();
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
        });
      }
    }
  });

  test('un pago en moneda distinta a la de la compra se anula y el saldo vuelve exacto, sin residuo de redondeo (D-039)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    let purchaseId = '';

    try {
      // Compra en USD: 10 000 + 18 % = 11 800 USD.
      const purchase = await expensePurchase(api, supplier.id, '10000', 'USD');
      purchaseId = purchase.id;
      expect(purchase.currency).toBe('USD');
      expect(purchase.total).toBe('11800.0000');

      // Pago en PEN contra una compra en USD: la conversión divide por el tipo de cambio,
      // y dejar decimales periódicos es lo normal (D-039); lo que interesa acá es que la
      // reversa no arrastre el redondeo de la conversión.
      const paid = await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/payments`, {
        date: new Date().toISOString().slice(0, 10),
        amount: '4000',
        currency: 'PEN',
        exchangeRate: '3.7',
        method: 'TRANSFER',
        reference: 'E2E-M2-USD',
      });
      // 4000 / 3.7 = 1081.081081... → redondeado (HALF_UP) a 1081.0811.
      expect(paid.balance).toBe('10718.9189');
      const paymentId = paid.payments[0]!.id;

      const reversed = await postJson<PurchaseDto>(
        api,
        `/api/purchases/${purchaseId}/payments/${paymentId}/reverse`,
        { reason: 'Se corrige la moneda del pago (prueba E2E)' },
      );
      // La reversa filtra el pago del cálculo, no resta el monto convertido: vuelve exacto
      // al total, sin residuo de céntimos.
      expect(reversed.balance).toBe('11800.0000');
      expect(reversed.paidAmount).toBe('0.0000');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
        });
      }
    }
  });

  test('el estado de cuenta del proveedor refleja el saldo antes y después de anular el pago', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    let purchaseId = '';

    try {
      // 10 000 + 18 % = 11 800.
      const purchase = await expensePurchase(api, supplier.id, '10000');
      purchaseId = purchase.id;

      const paid = await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/payments`, {
        date: new Date().toISOString().slice(0, 10),
        amount: '4000',
        currency: 'PEN',
        method: 'TRANSFER',
        reference: 'E2E-M2-STMT',
      });
      expect(paid.balance).toBe('7800.0000');
      const paymentId = paid.payments[0]!.id;

      const before = await getJson<StatementDto>(
        api,
        `/api/purchases/suppliers/${supplier.id}/statement`,
      );
      expect(before.totalBalancePen).toBe('7800.0000');
      expect(before.purchases).toHaveLength(1);
      expect(before.purchases[0]).toMatchObject({
        documentLabel: purchase.documentLabel,
        balance: '7800.0000',
        balancePen: '7800.0000',
      });

      await postJson<PurchaseDto>(
        api,
        `/api/purchases/${purchaseId}/payments/${paymentId}/reverse`,
        { reason: 'Se corrige el pago para revisar el estado de cuenta (prueba E2E)' },
      );

      const after = await getJson<StatementDto>(
        api,
        `/api/purchases/suppliers/${supplier.id}/statement`,
      );
      expect(after.totalBalancePen).toBe('11800.0000');
      expect(after.purchases).toHaveLength(1);
      expect(after.purchases[0]).toMatchObject({
        documentLabel: purchase.documentLabel,
        balance: '11800.0000',
        balancePen: '11800.0000',
      });
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
        });
      }
    }
  });

  test('un SUPERVISOR_PLANTA o un VENDEDOR no pueden anular un pago a proveedor (403)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    const seller = await createUser(api, 'VENDEDOR');
    let purchaseId = '';

    try {
      // 2 000 + 18 % = 2 360.
      const purchase = await expensePurchase(api, supplier.id, '2000');
      purchaseId = purchase.id;

      const paid = await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/payments`, {
        date: new Date().toISOString().slice(0, 10),
        amount: '1000',
        currency: 'PEN',
        method: 'TRANSFER',
        reference: 'E2E-M2-ROL',
      });
      const paymentId = paid.payments[0]!.id;

      const supervisorApi = await apiAs(baseURL!, supervisor);
      const sellerApi = await apiAs(baseURL!, seller);

      const bySupervisor = await postExpectingError(
        supervisorApi,
        `/api/purchases/${purchaseId}/payments/${paymentId}/reverse`,
        { reason: 'Intento sin permiso (prueba E2E)' },
      );
      expect(bySupervisor.status).toBe(403);

      const bySeller = await postExpectingError(
        sellerApi,
        `/api/purchases/${purchaseId}/payments/${paymentId}/reverse`,
        { reason: 'Intento sin permiso (prueba E2E)' },
      );
      expect(bySeller.status).toBe(403);

      // Ningún intento bloqueado tocó el pago: sigue vigente con el mismo saldo.
      const stillLive = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseId}`);
      expect(stillLive.payments[0]?.reversedAt).toBeNull();
      // 2 360 − 1 000 = 1 360.
      expect(stillLive.balance).toBe('1360.0000');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
        });
      }
    }
  });

  test('anular un pago con el id de otra compra (o inexistente) falla con 404 y no toca el pago ajeno', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    let purchaseAId = '';
    let purchaseBId = '';

    try {
      // A: 5 000 + 18 % = 5 900.
      const purchaseA = await expensePurchase(api, supplier.id, '5000');
      purchaseAId = purchaseA.id;
      const paidA = await postJson<PurchaseDto>(api, `/api/purchases/${purchaseAId}/payments`, {
        date: new Date().toISOString().slice(0, 10),
        amount: '2000',
        currency: 'PEN',
        method: 'TRANSFER',
        reference: 'E2E-M2-AJENO',
      });
      const paymentAId = paidA.payments[0]!.id;

      // B: compra distinta, sin relación con el pago de A.
      const purchaseB = await expensePurchase(api, supplier.id, '3000');
      purchaseBId = purchaseB.id;

      // Un id de pago que no existe, sobre una compra real.
      const notFound = await postExpectingError(
        api,
        `/api/purchases/${purchaseBId}/payments/${randomUUID()}/reverse`,
        { reason: 'Pago que no existe (prueba E2E)' },
      );
      expect(notFound.status).toBe(404);

      // Un pago real, pero de OTRA compra: tampoco se puede anular desde acá.
      const wrongPurchase = await postExpectingError(
        api,
        `/api/purchases/${purchaseBId}/payments/${paymentAId}/reverse`,
        { reason: 'Pago de otra compra (prueba E2E)' },
      );
      expect(wrongPurchase.status).toBe(404);

      // El pago original de A sigue intacto, ningún intento ajeno lo tocó.
      const stillLive = await getJson<PurchaseDto>(api, `/api/purchases/${purchaseAId}`);
      expect(stillLive.payments.find((p) => p.id === paymentAId)?.reversedAt).toBeNull();
      // 5 900 − 2 000 = 3 900.
      expect(stillLive.balance).toBe('3900.0000');
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          purchaseIds: [purchaseAId, purchaseBId].filter((id): id is string => !!id),
          supplierId: supplier.id,
        });
      }
    }
  });

  test('un pago sobre una compra COIL ya recibida se anula sin tocar el kardex ni la bobina (el pago nunca roza el stock)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';

    try {
      const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
        supplierId: supplier.id,
        businessLine: 'drywall',
        type: 'COIL',
        docType: 'FACTURA',
        series: 'F001',
        number: uniqueDocumentNumber(),
        issueDate: new Date().toISOString().slice(0, 10),
        currency: 'PEN',
        igvRate: '18',
        paymentTerms: 'CONTADO',
        items: [
          {
            description: 'Bobina E2E M-2 para probar el pago',
            qty: '1000',
            unit: 'KGM',
            unitPrice: '4',
            finishId: finish.id,
            widthMm: '1200',
            thicknessMm: '2',
          },
        ],
      });
      purchaseId = purchase.id;

      const received = await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/receive`);
      expect(received.status).toBe('RECEIVED');
      // 1000 kg × S/ 4 + 18 % = 4 720.
      expect(received.total).toBe('4720.0000');

      const coils = await getJson<CoilDto[]>(api, `/api/coils?supplierId=${supplier.id}`);
      expect(coils).toHaveLength(1);
      const coil = coils[0]!;

      const movementsBefore = await getJson<MovementDto[]>(
        api,
        `/api/inventory/movements?itemType=COIL&itemId=${coil.id}`,
      );
      const balanceBefore = await getJson<BalanceDto[]>(
        api,
        `/api/inventory/balances?itemType=COIL&itemId=${coil.id}`,
      );

      const paid = await postJson<PurchaseDto>(api, `/api/purchases/${purchaseId}/payments`, {
        date: new Date().toISOString().slice(0, 10),
        amount: '2000',
        currency: 'PEN',
        method: 'TRANSFER',
        reference: 'E2E-M2-COIL',
      });
      expect(paid.balance).toBe('2720.0000');
      const paymentId = paid.payments[0]!.id;

      const reversed = await postJson<PurchaseDto>(
        api,
        `/api/purchases/${purchaseId}/payments/${paymentId}/reverse`,
        { reason: 'Se corrige un pago mal registrado (prueba E2E)' },
      );
      expect(reversed.balance).toBe('4720.0000');

      // El pago y su reversa nunca tocan el kardex de la bobina (§3.2): mismos movimientos,
      // mismo saldo, antes y después.
      const movementsAfter = await getJson<MovementDto[]>(
        api,
        `/api/inventory/movements?itemType=COIL&itemId=${coil.id}`,
      );
      const balanceAfter = await getJson<BalanceDto[]>(
        api,
        `/api/inventory/balances?itemType=COIL&itemId=${coil.id}`,
      );
      expect(movementsAfter).toEqual(movementsBefore);
      expect(balanceAfter).toEqual(balanceBefore);

      const coilAfter = await getJson<CoilDto[]>(api, `/api/coils?supplierId=${supplier.id}`);
      expect(coilAfter[0]).toMatchObject({
        status: coil.status,
        weightKg: coil.weightKg,
        availableKg: coil.availableKg,
      });
    } finally {
      if (isProduction) {
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
          finish,
        });
      }
    }
  });
});
