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
import { loginAndSetPassword } from '../helpers/ui';

const isProduction = !!process.env.E2E_BASE_URL;
/**
 * Fase 2b: partido de bobina (RF-15/16), merma y su anulación (RF-17/18), anulación de
 * una compra ya recibida y landed cost (D-043). Todos los escenarios escriben —mueven
 * kardex, que es append-only—, así que contra producción solo corren si se piden de
 * forma explícita (D-024), igual que Fase 1 y Fase 2a.
 *
 * Reversión: cada test deshace en su `finally` lo que el propio dominio permite deshacer
 * (revertir el partido, anular la merma, anular las compras que quedaron sin pagos) y
 * desactiva los maestros que creó —proveedor, acabado y el producto de trading que nace
 * de la primera bobina de cada tipo (D-037)—, de modo que el rastro queda inerte y
 * reconocible por el prefijo E2E. Lo que el kardex no deja borrar (los movimientos y sus
 * reversas) queda visible como corresponde a §3.2.
 */
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

const ADMIN_PASSWORD = 'ClaveAdminE2E-2026';
/** Contraseña definitiva de los usuarios efímeros que solo se usan por API. */
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
  relatedPurchaseId: string | null;
  serviceKind: string | null;
}

interface CoilDto {
  id: string;
  code: string;
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

interface MovementDto {
  id: string;
  itemId: string;
  type: string;
  qty: string;
  unit: string;
  unitCost: string | null;
  totalCost: string | null;
  refType: string;
  refId: string | null;
  notes: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  balanceQty: string | null;
  balanceAvgCost: string | null;
}

interface BalanceDto {
  itemId: string;
  qty: string;
  avgCost: string | null;
  totalValue: string | null;
}

interface SplitDto {
  id: string;
  parentCoilId: string;
  splitWeightKg: string;
  kerfLossMm: string;
  kerfLossKg: string;
  status: string;
  revertedAt: string | null;
  children: { id: string; code: string; widthMm: string; weightKg: string; status: string }[];
}

interface SummaryRowDto {
  key: string;
  itemType: string;
  qty: string;
  avgCostPen: string | null;
  totalValuePen: string | null;
  itemCount: number;
}

interface SummaryDto {
  businessLine: string;
  coils: SummaryRowDto[];
  totalValuePen: string | null;
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

interface CoilLineInput {
  description: string;
  weightKg: string;
  widthMm: string;
  thicknessMm: string;
  unitPricePerKg: string;
}

/**
 * Compra de bobinas ya recibida: una bobina por línea, con su ingreso en el kardex
 * (D-030). Se crea por API porque lo que prueban estos tests es lo que pasa **después**
 * de la recepción; el alta por formulario ya la cubre Fase 2a.
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

/**
 * Kardex completo de una bobina, en orden cronológico. El API lo devuelve del más
 * reciente al más antiguo (así lo pinta la vista), así que acá se invierte para poder
 * leer las aserciones en el orden en que ocurrieron los movimientos.
 */
async function coilMovements(api: APIRequestContext, coilId: string): Promise<MovementDto[]> {
  const movements = await getJson<MovementDto[]>(
    api,
    `/api/inventory/movements?itemType=COIL&itemId=${coilId}`,
  );
  return movements.reverse();
}

/** Saldo del kardex de una bobina (cantidad y costo promedio vigente). */
async function coilBalance(api: APIRequestContext, coilId: string): Promise<BalanceDto> {
  const balances = await getJson<BalanceDto[]>(
    api,
    `/api/inventory/balances?itemType=COIL&itemId=${coilId}`,
  );
  expect(balances, `La bobina ${coilId} no tiene saldo de kardex`).toHaveLength(1);
  return balances[0]!;
}

/**
 * Contexto de API autenticado como un usuario recién creado. El primer ingreso obliga a
 * cambiar la contraseña temporal (RF-01) y el guard bloquea todo lo demás hasta hacerlo,
 * así que el cambio va acá adentro; la sesión actual sobrevive al cambio.
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

/** PATCH al API con el contexto ya autenticado; falla con el cuerpo real si no es 2xx. */
async function patchJson<T>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await api.patch(path, { data });
  if (!res.ok()) throw new Error(`PATCH ${path} falló: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
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

/** PATCH que se espera que falle. */
async function patchExpectingError(
  api: APIRequestContext,
  path: string,
  data: unknown,
): Promise<ApiError> {
  return errorFrom(await api.patch(path, { data }), `PATCH ${path}`);
}

/**
 * Deja inerte en producción lo que el test creó: anula las compras que todavía admiten
 * anulación (sin pagos y sin movimientos posteriores vivos) y desactiva proveedor,
 * acabado y los productos de trading nacidos de las bobinas. Nunca lanza: es limpieza
 * de `finally`. Las compras van en el orden en que se pasan, porque un flete (D-043)
 * tiene que anularse antes que la compra de bobinas a la que se imputó.
 */
async function deactivateTrail(
  api: APIRequestContext,
  trail: { purchaseIds?: string[]; supplierId?: string; finish?: CreatedFinish },
): Promise<void> {
  for (const purchaseId of trail.purchaseIds ?? []) {
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

test.describe('Fase 2b — partido, merma, anulación y landed cost', () => {
  test.skip(skipWrites, 'Mueve kardex: en produccion solo con E2E_ALLOW_WRITES=1');

  // Cada escenario encadena varias operaciones transaccionales contra Neon (compra,
  // recepción, partido o merma, y su reversa) y dos de ellos además navegan la UI, que
  // en local compila cada ruta la primera vez: el timeout global de 45 s queda corto.
  test.beforeEach(() => {
    test.setTimeout(150_000);
  });

  test('partir una bobina crea 2 hijas con el peso prorrateado por ancho y deja el kardex cuadrado (RF-15)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let splitId = '';
    let purchaseId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E para partir',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const mother = coils[0]!;
      expect(mother.availableKg).toBe('5000.000');
      expect(mother.status).toBe('OPEN');

      // Partido parcial: 3 000 de los 5 000 kg en dos tiras de 600 y 560 mm. Cubren
      // 1 160 de los 1 220 mm de la madre (95%), por encima del piso del 80%.
      const children = await postJson<CoilDto[]>(api, `/api/coils/${mother.id}/split`, {
        splitWeightKg: '3000',
        kerfLossMm: '0',
        children: [
          { widthMm: '600', count: 1 },
          { widthMm: '560', count: 1 },
        ],
      });

      expect(children).toHaveLength(2);
      // Prorrateo por ancho SOBRE EL ANCHO DE LA MADRE (no sobre la suma de los anchos):
      // 3000 × 600/1220 = 1475.410 y 3000 × 1160/1220 − 1475.410 = 1377.049.
      expect(children[0]).toMatchObject({
        parentCoilId: mother.id,
        widthMm: '600.00',
        weightKg: '1475.410',
        availableKg: '1475.410',
        thicknessMm: '2.00',
        typeKey: mother.typeKey,
        status: 'OPEN',
      });
      expect(children[1]).toMatchObject({
        parentCoilId: mother.id,
        widthMm: '560.00',
        weightKg: '1377.049',
        availableKg: '1377.049',
        typeKey: mother.typeKey,
        status: 'OPEN',
      });
      // Las hijas heredan el costo por kg de la madre (RF-15) y siguen colgando de la
      // misma compra, así que la trazabilidad al comprobante no se pierde.
      for (const child of children) {
        expect(child.unitCostPerKg).toBe('4.0000');
        expect(child.purchaseId).toBe(purchase.id);
        expect(child.splitId).not.toBeNull();
      }

      const splits = await getJson<SplitDto[]>(api, `/api/coils/${mother.id}/splits`);
      expect(splits).toHaveLength(1);
      splitId = splits[0]!.id;
      expect(splits[0]).toMatchObject({
        parentCoilId: mother.id,
        splitWeightKg: '3000.000',
        status: 'ACTIVE',
        revertedAt: null,
      });
      // Lo que no quedó en una hija es pérdida de corte: 3000 − 2852.459 = 147.541 kg.
      expect(splits[0]!.kerfLossKg).toBe('147.541');

      // La madre conserva su ancho y pierde solo el peso partido (D-041).
      const motherAfter = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfter.availableKg).toBe('2000.000');
      expect(motherAfter.widthMm).toBe('1220.00');
      // Queda abierta porque le sobró saldo; si el partido la hubiera dejado en cero,
      // el API la cierra (RF-19).
      expect(motherAfter.status).toBe('OPEN');

      // Kardex de la madre: su ingreso de compra más la salida del partido.
      const motherMovements = await coilMovements(api, mother.id);
      expect(motherMovements).toHaveLength(2);
      expect(motherMovements[0]).toMatchObject({
        type: 'IN',
        refType: 'PURCHASE',
        qty: '5000.000',
      });
      expect(motherMovements[1]).toMatchObject({
        type: 'OUT',
        refType: 'SPLIT',
        refId: splitId,
        qty: '3000.000',
        // La salida se valoriza al promedio ponderado vigente (D-028).
        unitCost: '4.0000',
        totalCost: '12000.0000',
        balanceQty: '2000.000',
        reversalOfId: null,
      });

      // Un IN por hija bajo el mismo partido, al mismo costo por kilo que salió de la
      // madre: el valor del inventario solo pierde la merma de corte.
      const expectedChildren = [
        { qty: '1475.410', totalCost: '5901.6400' },
        { qty: '1377.049', totalCost: '5508.1960' },
      ];
      for (const [index, child] of children.entries()) {
        const movements = await coilMovements(api, child.id);
        expect(movements).toHaveLength(1);
        expect(movements[0]).toMatchObject({
          type: 'IN',
          refType: 'SPLIT',
          refId: splitId,
          qty: expectedChildren[index]!.qty,
          unit: 'KGM',
          unitCost: '4.0000',
          totalCost: expectedChildren[index]!.totalCost,
        });
      }

      // El valor total del kardex no se inventa kilos: madre + hijas = 5 000 − 147.541.
      const balances = await Promise.all(
        [mother, ...children].map((coil) => coilBalance(api, coil.id)),
      );
      const totalKg = balances.reduce((acc, b) => acc + Number.parseFloat(b.qty), 0);
      expect(totalKg).toBeCloseTo(5000 - 147.541, 3);

      // --- Verificación por la UI (RF-15 en /bobinas/[id]) ---
      await loginAndSetPassword(page, admin, ADMIN_PASSWORD);
      await page.goto(`/bobinas/${mother.id}`);
      await expect(page.getByRole('heading', { name: mother.code })).toBeVisible();
      await expect(page.getByText('2,000.000 kg').first()).toBeVisible();

      // El partido aparece con sus dos hijas, su peso y su merma de corte. La fila se
      // identifica por el código de una hija, que solo existe en la tabla de partidos:
      // el peso partido también aparece en el kardex, más abajo en la misma página.
      const splitRow = page.getByRole('row').filter({ hasText: children[0]!.code });
      await expect(splitRow).toBeVisible();
      await expect(splitRow).toContainText('3,000.000 kg');
      await expect(splitRow).toContainText('147.541 kg');
      for (const child of children) {
        await expect(splitRow.getByRole('link', { name: new RegExp(child.code) })).toBeVisible();
      }

      // Y el kardex de la bobina muestra el ingreso de compra y la salida del partido con
      // su saldo corrido, en español y con el símbolo de la unidad (`KGM` → `kg`).
      const kardexPurchaseRow = page.getByRole('row').filter({ hasText: 'Compra' });
      await expect(kardexPurchaseRow).toContainText('Entrada');
      await expect(kardexPurchaseRow).toContainText('5,000.000 kg');
      const kardexSplitRow = page.getByRole('row').filter({ hasText: 'Partido de bobina' });
      await expect(kardexSplitRow).toContainText('Salida');
      await expect(kardexSplitRow).toContainText('Partido en 2 bobinas hijas');
      await expect(kardexSplitRow).toContainText('3,000.000 kg');
      await expect(kardexSplitRow).toContainText('2,000.000 kg');
    } finally {
      if (isProduction) {
        // Se revierte el partido —lo único reversible acá— y se anula la compra, que
        // vuelve a quedar sin movimientos vivos. Los maestros quedan desactivados.
        if (splitId) {
          await api
            .post(`/api/coils/splits/${splitId}/revert`, {
              data: { reason: 'Limpieza de prueba E2E' },
            })
            .catch(() => undefined);
        }
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
          finish,
        });
      }
    }
  });

  test('revertir un partido anula las hijas, devuelve el peso a la madre y no se puede repetir (RF-16)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E para partir y revertir',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const mother = coils[0]!;

      // Partido total: la madre queda en cero y el API la cierra (RF-19).
      const children = await postJson<CoilDto[]>(api, `/api/coils/${mother.id}/split`, {
        kerfLossMm: '0',
        children: [
          { widthMm: '600', count: 1 },
          { widthMm: '560', count: 1 },
        ],
      });
      expect(children).toHaveLength(2);
      const closed = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(closed.status).toBe('CLOSED');
      expect(closed.availableKg).toBe('0.000');

      const splits = await getJson<SplitDto[]>(api, `/api/coils/${mother.id}/splits`);
      const splitId = splits[0]!.id;
      const outMovement = (await coilMovements(api, mother.id)).find(
        (m) => m.refType === 'SPLIT' && m.type === 'OUT',
      );
      expect(outMovement).toBeDefined();
      const childInMovements = await Promise.all(
        children.map(async (child) => (await coilMovements(api, child.id))[0]!),
      );

      // --- Reversa (RF-16) ---
      const reverted = await postJson<SplitDto[]>(api, `/api/coils/splits/${splitId}/revert`, {
        reason: 'El ancho de corte estaba mal en la orden',
      });
      expect(reverted).toHaveLength(1);
      expect(reverted[0]).toMatchObject({ id: splitId, status: 'REVERTED' });
      expect(reverted[0]!.revertedAt).not.toBeNull();

      // Las hijas quedan anuladas y sin saldo; no se borran (§3.2).
      for (const child of children) {
        const after = await getJson<CoilDto>(api, `/api/coils/${child.id}`);
        expect(after.status).toBe('CANCELLED');
        expect(after.availableKg).toBe('0.000');
      }

      // La madre recupera su peso y vuelve a abrirse.
      const motherAfter = await getJson<CoilDto>(api, `/api/coils/${mother.id}`);
      expect(motherAfter.availableKg).toBe('5000.000');
      expect(motherAfter.status).toBe('OPEN');
      const motherBalance = await coilBalance(api, mother.id);
      expect(motherBalance).toMatchObject({ qty: '5000.000', avgCost: '4.0000' });

      // Kardex: el inverso de la salida de la madre apunta al movimiento original.
      const motherMovements = await coilMovements(api, mother.id);
      expect(motherMovements).toHaveLength(3);
      expect(motherMovements[2]).toMatchObject({
        type: 'IN',
        refType: 'SPLIT',
        qty: '5000.000',
        reversalOfId: outMovement!.id,
        notes: 'El ancho de corte estaba mal en la orden',
        balanceQty: '5000.000',
      });
      // Y el movimiento original queda marcado como anulado, no borrado.
      expect(motherMovements[1]).toMatchObject({
        id: outMovement!.id,
        reversedById: motherMovements[2]!.id,
      });

      // Cada hija tiene su ingreso y la salida que lo anula.
      for (const [index, child] of children.entries()) {
        const movements = await coilMovements(api, child.id);
        expect(movements).toHaveLength(2);
        expect(movements[1]).toMatchObject({
          type: 'OUT',
          refType: 'SPLIT',
          reversalOfId: childInMovements[index]!.id,
          qty: childInMovements[index]!.qty,
          totalCost: childInMovements[index]!.totalCost,
          balanceQty: '0.000',
        });
      }

      // Revertir dos veces no puede duplicar el peso de la madre.
      const second = await postExpectingError(api, `/api/coils/splits/${splitId}/revert`, {
        reason: 'Intento repetido de la misma reversa',
      });
      expect(second.status).toBe(409);
      expect(second.message).toContain('ya fue revertido');
      expect((await getJson<CoilDto>(api, `/api/coils/${mother.id}`)).availableKg).toBe('5000.000');
    } finally {
      if (isProduction) {
        // El partido ya quedó revertido dentro del test: la compra vuelve a ser anulable.
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
          finish,
        });
      }
    }
  });

  test('una merma baja el disponible al costo promedio vigente y su anulación lo devuelve (RF-17, RF-18, D-040)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E con borde oxidado',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const coil = coils[0]!;

      const before = await coilBalance(api, coil.id);
      expect(before).toMatchObject({
        qty: '5000.000',
        avgCost: '4.0000',
        totalValue: '20000.0000',
      });

      // --- Merma (RF-17) ---
      const scrapped = await postJson<CoilDto>(api, `/api/coils/${coil.id}/scrap`, {
        qtyKg: '500',
        reason: 'Borde oxidado descartado en planta',
      });
      expect(scrapped.availableKg).toBe('4500.000');

      const movements = await coilMovements(api, coil.id);
      expect(movements).toHaveLength(2);
      const scrapMovement = movements[1]!;
      expect(scrapMovement).toMatchObject({
        type: 'OUT',
        refType: 'SCRAP',
        refId: coil.id,
        qty: '500.000',
        unit: 'KGM',
        // D-040: sale valorizada al costo promedio vigente, no al del documento.
        unitCost: before.avgCost,
        totalCost: '2000.0000',
        notes: 'Borde oxidado descartado en planta',
        reversalOfId: null,
        balanceQty: '4500.000',
      });

      // Una salida no mueve el promedio: baja la cantidad y el valor en la misma
      // proporción (D-028).
      const afterScrap = await coilBalance(api, coil.id);
      expect(afterScrap).toMatchObject({
        qty: '4500.000',
        avgCost: '4.0000',
        totalValue: '18000.0000',
      });

      // --- Anulación de la merma (RF-18) ---
      const restored = await postJson<CoilDto>(
        api,
        `/api/coils/scraps/${scrapMovement.id}/cancel`,
        { reason: 'La merma se registró sobre la bobina equivocada' },
      );
      expect(restored.availableKg).toBe(before.qty);

      const afterCancel = await coilBalance(api, coil.id);
      expect(afterCancel).toMatchObject({
        qty: before.qty,
        avgCost: before.avgCost,
        totalValue: before.totalValue,
      });

      const movementsAfter = await coilMovements(api, coil.id);
      expect(movementsAfter).toHaveLength(3);
      expect(movementsAfter[2]).toMatchObject({
        type: 'IN',
        refType: 'SCRAP',
        qty: '500.000',
        // La reversa arrastra el valor del movimiento original, no el promedio del momento.
        totalCost: '2000.0000',
        reversalOfId: scrapMovement.id,
        notes: 'La merma se registró sobre la bobina equivocada',
        balanceQty: '5000.000',
      });
      expect(movementsAfter[1]).toMatchObject({
        id: scrapMovement.id,
        reversedById: movementsAfter[2]!.id,
      });

      // Anular dos veces la misma merma dejaría kilos de la nada en el saldo.
      const twice = await postExpectingError(api, `/api/coils/scraps/${scrapMovement.id}/cancel`, {
        reason: 'Intento repetido de la misma anulación',
      });
      expect(twice.status).toBe(409);
      expect((await getJson<CoilDto>(api, `/api/coils/${coil.id}`)).availableKg).toBe('5000.000');
    } finally {
      if (isProduction) {
        // La merma ya quedó anulada: la compra es anulable y el rastro queda inerte.
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
          finish,
        });
      }
    }
  });

  test('anular una compra recibida se bloquea nombrando la bobina que la traba y funciona al anular la merma', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E de compra a anular',
            weightKg: '4000',
            widthMm: '1200',
            thicknessMm: '1.5',
            unitPricePerKg: '3.5',
          },
        ],
      });
      const coil = coils[0]!;

      await postJson<CoilDto>(api, `/api/coils/${coil.id}/scrap`, {
        qtyKg: '200',
        reason: 'Golpe en el embalaje',
      });

      // Con la merma viva, anular la compra dejaría el saldo en negativo: el API corta
      // y dice exactamente qué bobina y qué movimiento lo impiden.
      const blocked = await postExpectingError(api, `/api/purchases/${purchase.id}/cancel`, {
        reason: 'La factura llegó con el proveedor equivocado',
      });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain(coil.code);
      expect(blocked.message).toContain('SCRAP');
      // La compra sigue recibida: el intento fallido no cambió nada.
      const stillReceived = await getJson<PurchaseDto>(api, `/api/purchases/${purchase.id}`);
      expect(stillReceived.status).toBe('RECEIVED');
      expect((await getJson<CoilDto>(api, `/api/coils/${coil.id}`)).status).toBe('OPEN');

      // Se anula la merma: el par movimiento + reversa se cancela entre sí y ya no
      // bloquea (fix de `liveMovements` del commit 029f480).
      const scrapMovement = (await coilMovements(api, coil.id)).find(
        (m) => m.refType === 'SCRAP' && !m.reversalOfId,
      );
      expect(scrapMovement).toBeDefined();
      await postJson<CoilDto>(api, `/api/coils/scraps/${scrapMovement!.id}/cancel`, {
        reason: 'La merma no correspondía a esta bobina',
      });

      const cancelled = await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/cancel`, {
        reason: 'La factura llegó con el proveedor equivocado',
      });
      expect(cancelled.status).toBe('CANCELLED');

      // La bobina de la compra queda anulada y su ingreso revertido en el kardex.
      const coilAfter = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
      expect(coilAfter.status).toBe('CANCELLED');
      expect(coilAfter.availableKg).toBe('0.000');

      const movements = await coilMovements(api, coil.id);
      // IN de la compra, OUT de la merma, IN que la anula y OUT que revierte el ingreso.
      expect(movements).toHaveLength(4);
      expect(movements[3]).toMatchObject({
        type: 'OUT',
        refType: 'PURCHASE',
        qty: '4000.000',
        reversalOfId: movements[0]!.id,
        balanceQty: '0.000',
      });
      const balance = await coilBalance(api, coil.id);
      expect(balance.qty).toBe('0.000');

      // Y ya no hay cuenta por pagar contra el proveedor por esta compra.
      const reloaded = await getJson<PurchaseDto>(api, `/api/purchases/${purchase.id}`);
      expect(reloaded.status).toBe('CANCELLED');
    } finally {
      if (isProduction) {
        // La compra ya quedó anulada dentro del test; solo restan los maestros.
        await deactivateTrail(api, { supplierId: supplier.id, finish });
      }
    }
  });

  test('una compra con una bobina recosteada se anula igual, revirtiendo solo el ingreso vivo (D-045)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E recosteada y después desfacturada',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      const coil = coils[0]!;

      // D-045 deja bajo el mismo `refType=PURCHASE`/`refId` tres movimientos: el ingreso
      // original, su reversa y el ingreso al costo corregido. Solo el último está vivo.
      await patchJson<CoilDto>(api, `/api/coils/${coil.id}`, {
        unitCostPerKg: '4.8',
        reason: 'Nota de débito del proveedor por el precio por kilo',
      });
      const beforeCancel = await coilMovements(api, coil.id);
      expect(beforeCancel).toHaveLength(3);

      // Antes del fix de `liveMovements` en `cancel`, esto reventaba con "Un movimiento
      // de anulación no se puede volver a anular" y la compra no se podía anular nunca.
      const cancelled = await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/cancel`, {
        reason: 'La factura estaba a nombre de otra empresa del grupo',
      });
      expect(cancelled.status).toBe('CANCELLED');

      const coilAfter = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
      expect(coilAfter.status).toBe('CANCELLED');
      expect(coilAfter.availableKg).toBe('0.000');

      // Un solo movimiento nuevo: la reversa del ingreso recosteado, que es el que
      // seguía vivo. El ingreso original ya estaba revertido y no se toca otra vez.
      const movements = await coilMovements(api, coil.id);
      expect(movements).toHaveLength(4);
      expect(movements.slice(0, 3).map((m) => m.id)).toEqual(beforeCancel.map((m) => m.id));
      expect(movements[2]).toMatchObject({
        type: 'IN',
        unitCost: '4.8000',
        totalCost: '24000.0000',
        reversedById: movements[3]!.id,
      });
      expect(movements[3]).toMatchObject({
        type: 'OUT',
        refType: 'PURCHASE',
        qty: '5000.000',
        totalCost: '24000.0000',
        reversalOfId: movements[2]!.id,
        balanceQty: '0.000',
      });

      // Ninguna reversa duplicada: dos anulaciones, una por cada ingreso, y cada una
      // apunta a un movimiento distinto (el índice único de `reversalOfId` lo respalda).
      const reversalTargets = movements.map((m) => m.reversalOfId).filter((id) => id !== null);
      expect(reversalTargets).toHaveLength(2);
      expect(new Set(reversalTargets).size).toBe(2);
      expect(reversalTargets).toEqual([movements[0]!.id, movements[2]!.id]);

      // Y el kardex del ítem cierra en cero.
      expect((await coilBalance(api, coil.id)).qty).toBe('0.000');
    } finally {
      if (isProduction) {
        // La compra ya quedó anulada dentro del test; solo restan los maestros.
        await deactivateTrail(api, { supplierId: supplier.id, finish });
      }
    }
  });

  test('anular una compra con una bobina ya anulada revierte la otra y no vuelve a mover la primera (RF-21)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E anulada a mano',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
          {
            description: 'Bobina E2E que sigue viva',
            weightKg: '3000',
            widthMm: '1000',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      const alreadyCancelled = coils.find((c) => c.weightKg === '5000.000');
      const stillLive = coils.find((c) => c.weightKg === '3000.000');
      expect(alreadyCancelled, 'No se creó la bobina de 5 000 kg').toBeDefined();
      expect(stillLive, 'No se creó la bobina de 3 000 kg').toBeDefined();

      // RF-21 sobre una sola bobina: su ingreso queda revertido, el de la otra no.
      await postJson<CoilDto>(api, `/api/coils/${alreadyCancelled!.id}/cancel`, {
        reason: 'Esta bobina no llegó en el camión',
      });
      const beforeCancel = await coilMovements(api, alreadyCancelled!.id);
      expect(beforeCancel).toHaveLength(2);
      expect(await coilMovements(api, stillLive!.id)).toHaveLength(1);

      const cancelled = await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/cancel`, {
        reason: 'El proveedor emitió una nota de crédito por toda la factura',
      });
      expect(cancelled.status).toBe('CANCELLED');

      // La bobina ya anulada no recibe ningún movimiento nuevo: su ingreso estaba
      // revertido y volver a sacarlo dejaría el saldo del ítem en negativo.
      const untouched = await coilMovements(api, alreadyCancelled!.id);
      expect(untouched.map((m) => m.id)).toEqual(beforeCancel.map((m) => m.id));
      expect((await coilBalance(api, alreadyCancelled!.id)).qty).toBe('0.000');

      // La otra sí se revierte: el filtro es por movimiento vivo, no por compra.
      const reverted = await coilMovements(api, stillLive!.id);
      expect(reverted).toHaveLength(2);
      expect(reverted[1]).toMatchObject({
        type: 'OUT',
        refType: 'PURCHASE',
        qty: '3000.000',
        totalCost: '12000.0000',
        reversalOfId: reverted[0]!.id,
        balanceQty: '0.000',
      });
      expect((await coilBalance(api, stillLive!.id)).qty).toBe('0.000');

      // Las dos bobinas quedan anuladas junto con la compra.
      for (const coil of [alreadyCancelled!, stillLive!]) {
        const after = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
        expect(after.status).toBe('CANCELLED');
        expect(after.availableKg).toBe('0.000');
      }
    } finally {
      if (isProduction) {
        // La compra ya quedó anulada dentro del test; solo restan los maestros.
        await deactivateTrail(api, { supplierId: supplier.id, finish });
      }
    }
  });

  test('el flete vinculado a la compra de bobinas sube el costo promedio del inventario valorizado (D-043)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const admin = await createUser(api, 'ADMINISTRADOR');
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let servicePurchaseId = '';
    let coilPurchaseId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E importada',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      coilPurchaseId = purchase.id;
      const coil = coils[0]!;

      // Estado del valorizado antes del flete: 5 000 kg a 4.0000 = 20 000 soles.
      const before = await getJson<SummaryDto>(api, `/api/inventory/summary?businessLine=${LINE}`);
      const rowBefore = before.coils.find((r) => r.key === coil.typeKey);
      expect(rowBefore, `El inventario no muestra el tipo ${coil.typeKey}`).toBeDefined();
      expect(rowBefore).toMatchObject({
        qty: '5000.000',
        avgCostPen: '4.0000',
        totalValuePen: '20000.0000',
        itemCount: 1,
      });

      // D-043: flete en la MISMA línea de negocio, vinculado a la compra de bobinas.
      // Crearlo exige rol ADMINISTRADOR, que es con el que corre este contexto.
      const freight = await postJson<PurchaseDto>(api, '/api/purchases', {
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
        serviceKind: 'FREIGHT',
        relatedPurchaseId: purchase.id,
        items: [
          { description: 'Flete de importación E2E', qty: '1', unit: 'ZZ', unitPrice: '2000' },
        ],
      });
      servicePurchaseId = freight.id;
      expect(freight).toMatchObject({
        type: 'SERVICE',
        serviceKind: 'FREIGHT',
        relatedPurchaseId: purchase.id,
        subtotal: '2000.0000',
        status: 'DRAFT',
      });

      // Mientras el flete siga en borrador no toca el costo de la bobina (D-030).
      expect(await coilMovements(api, coil.id)).toHaveLength(1);

      const received = await postJson<PurchaseDto>(api, `/api/purchases/${freight.id}/receive`);
      expect(received.status).toBe('RECEIVED');

      // El kardex de la bobina recibe un ADJUST: mueve costo, no cantidad.
      const movements = await coilMovements(api, coil.id);
      expect(movements).toHaveLength(2);
      expect(movements[1]).toMatchObject({
        type: 'ADJUST',
        refType: 'PURCHASE',
        refId: freight.id,
        qty: '5000.000',
        // 2 000 soles sin IGV repartidos por kilo: 0.40 por kg.
        unitCost: '0.4000',
        totalCost: '2000.0000',
        balanceQty: '5000.000',
      });
      expect(movements[1]!.notes).toContain(`${freight.series}-${freight.number}`);

      // El promedio del saldo y el costo del documento suben en la misma proporción.
      const balance = await coilBalance(api, coil.id);
      expect(balance).toMatchObject({
        qty: '5000.000',
        avgCost: '4.4000',
        totalValue: '22000.0000',
      });
      const coilAfter = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
      expect(coilAfter.unitCostPerKg).toBe('4.4000');
      expect(coilAfter.totalCostPen).toBe('22000.0000');

      // RF-51: el valorizado de la línea sube exactamente el monto del flete.
      const after = await getJson<SummaryDto>(api, `/api/inventory/summary?businessLine=${LINE}`);
      const rowAfter = after.coils.find((r) => r.key === coil.typeKey);
      expect(rowAfter).toMatchObject({
        qty: '5000.000',
        avgCostPen: '4.4000',
        totalValuePen: '22000.0000',
        itemCount: 1,
      });
      expect(Number.parseFloat(rowAfter!.avgCostPen!)).toBeGreaterThan(
        Number.parseFloat(rowBefore!.avgCostPen!),
      );
      expect(Number.parseFloat(after.totalValuePen!)).toBeCloseTo(
        Number.parseFloat(before.totalValuePen!) + 2000,
        2,
      );

      // --- Verificación por la UI (/inventario) ---
      await loginAndSetPassword(page, admin, ADMIN_PASSWORD);
      await page.goto('/inventario');
      await expect(page.getByRole('heading', { name: 'Inventario' })).toBeVisible();
      await page.getByRole('tab', { name: 'Drywall' }).click();

      const summaryRow = page.getByRole('row').filter({ hasText: coil.typeKey });
      await expect(summaryRow).toBeVisible();
      // El saldo se pinta con el símbolo de la unidad del kardex (`KGM` → `kg`).
      await expect(summaryRow).toContainText('5,000.000 kg');
      await expect(summaryRow).toContainText('S/ 4.4000');
      await expect(summaryRow).toContainText('S/ 22,000.00');
    } finally {
      if (isProduction) {
        // El flete se anula primero: su reversa devuelve el ADJUST y recién entonces la
        // compra de bobinas queda sin movimientos posteriores vivos.
        await deactivateTrail(api, {
          purchaseIds: [servicePurchaseId, coilPurchaseId].filter(Boolean),
          supplierId: supplier.id,
          finish,
        });
      }
    }
  });

  test('un partido que desperdicia más del 20% del ancho se rechaza y no toca el kardex (RF-15)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E de un solo corte',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const coil = coils[0]!;

      // Una sola tira de 300 mm de una madre de 1 220 mm aprovecha el 24%: eso no es un
      // partido, es dar de baja la bobina, y para eso está la merma (RF-17).
      const rejected = await postExpectingError(api, `/api/coils/${coil.id}/split`, {
        kerfLossMm: '0',
        children: [{ widthMm: '300', count: 1 }],
      });
      expect(rejected.status).toBe(400);
      expect(rejected.message).toContain('merma');

      // Nada quedó a medias: ni partido, ni hijas, ni movimiento de kardex.
      expect(await getJson<SplitDto[]>(api, `/api/coils/${coil.id}/splits`)).toHaveLength(0);
      expect(await getJson<CoilDto[]>(api, `/api/coils/${coil.id}/children`)).toHaveLength(0);
      expect(await coilMovements(api, coil.id)).toHaveLength(1);
      expect((await getJson<CoilDto>(api, `/api/coils/${coil.id}`)).availableKg).toBe('5000.000');
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

/**
 * Reparto de permisos de Fase 2b (D-046, §3.4) y ciclo de vida de la bobina: abrir y
 * cerrar (RF-19), recostear con reversa (RF-20, D-045) y anular (RF-21). Se apoya en los
 * mismos helpers del bloque anterior y cada test crea su proveedor, su acabado y su
 * compra, así que ninguno depende del orden.
 */
test.describe('Fase 2b — roles y ciclo de vida de la bobina (D-046, RF-19..RF-21)', () => {
  test.skip(skipWrites, 'Mueve kardex: en produccion solo con E2E_ALLOW_WRITES=1');

  test.beforeEach(() => {
    test.setTimeout(150_000);
  });

  test('un supervisor de planta parte, merma, anula la merma y revierte el partido (D-046)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supervisor = await apiAs(baseURL!, await createUser(api, 'SUPERVISOR_PLANTA'));
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E operada por planta',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const coil = coils[0]!;

      // RF-15: partir es trabajo de planta.
      const children = await postJson<CoilDto[]>(supervisor, `/api/coils/${coil.id}/split`, {
        splitWeightKg: '3000',
        kerfLossMm: '0',
        children: [
          { widthMm: '600', count: 1 },
          { widthMm: '560', count: 1 },
        ],
      });
      expect(children).toHaveLength(2);
      expect((await getJson<CoilDto>(supervisor, `/api/coils/${coil.id}`)).availableKg).toBe(
        '2000.000',
      );

      // RF-17: y registrar la merma de lo que quedó en la madre.
      const scrapped = await postJson<CoilDto>(supervisor, `/api/coils/${coil.id}/scrap`, {
        qtyKg: '200',
        reason: 'Punta golpeada en el traslado a planta',
      });
      expect(scrapped.availableKg).toBe('1800.000');

      // RF-18: el turno que se equivoca al tipear la merma la deshace sin llamar a un
      // administrador; ese es justo el motivo de D-046.
      const scrapMovement = (await coilMovements(supervisor, coil.id)).find(
        (m) => m.refType === 'SCRAP' && !m.reversalOfId,
      );
      expect(scrapMovement).toBeDefined();
      const restored = await postJson<CoilDto>(
        supervisor,
        `/api/coils/scraps/${scrapMovement!.id}/cancel`,
        { reason: 'La merma iba sobre otra bobina del lote' },
      );
      expect(restored.availableKg).toBe('2000.000');

      // RF-16: y revertir su propio partido.
      const splits = await getJson<SplitDto[]>(supervisor, `/api/coils/${coil.id}/splits`);
      expect(splits).toHaveLength(1);
      const reverted = await postJson<SplitDto[]>(
        supervisor,
        `/api/coils/splits/${splits[0]!.id}/revert`,
        { reason: 'Los anchos de la orden de corte estaban cambiados' },
      );
      expect(reverted[0]).toMatchObject({ id: splits[0]!.id, status: 'REVERTED' });

      const motherAfter = await getJson<CoilDto>(supervisor, `/api/coils/${coil.id}`);
      expect(motherAfter.availableKg).toBe('5000.000');
      expect(motherAfter.status).toBe('OPEN');
      for (const child of children) {
        expect((await getJson<CoilDto>(supervisor, `/api/coils/${child.id}`)).status).toBe(
          'CANCELLED',
        );
      }
    } finally {
      if (isProduction) {
        // El partido y la merma ya quedaron deshechos dentro del test.
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
          finish,
        });
      }
    }
  });

  test('un supervisor de planta no puede anular una bobina, editar su costo ni imputar landed cost (D-046, D-043)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supervisor = await apiAs(baseURL!, await createUser(api, 'SUPERVISOR_PLANTA'));
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E fuera del alcance de planta',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const coil = coils[0]!;

      // Lo que sí es suyo: los datos físicos, que no tocan el kardex (D-045).
      const edited = await patchJson<CoilDto>(supervisor, `/api/coils/${coil.id}`, {
        widthMm: '1210',
        notes: 'Reborde recortado en planta',
      });
      expect(edited.widthMm).toBe('1210.00');
      expect(await coilMovements(supervisor, coil.id)).toHaveLength(1);

      // RF-21: anular la bobina toca el documento de compra, no la planta.
      const cancel = await postExpectingError(supervisor, `/api/coils/${coil.id}/cancel`, {
        reason: 'Intento de anulación desde planta',
      });
      expect(cancel.status).toBe(403);

      // RF-20 / D-045: cambiar costo, moneda o tipo de cambio recuesta el kardex.
      for (const body of [
        { unitCostPerKg: '9', reason: 'Intento de recosteo desde planta' },
        { currency: 'USD', exchangeRate: '3.7', reason: 'Intento de cambio de moneda' },
      ]) {
        const denied = await patchExpectingError(supervisor, `/api/coils/${coil.id}`, body);
        expect(denied.status).toBe(403);
        expect(denied.message).toContain('administrador');
      }

      // D-043: imputar un flete mueve el costo promedio del inventario sin tope y sin
      // reversa al alcance de planta; lo levantó `auditor-seguridad`.
      const landed = await postExpectingError(supervisor, '/api/purchases', {
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
        serviceKind: 'FREIGHT',
        relatedPurchaseId: purchase.id,
        items: [{ description: 'Flete inventado E2E', qty: '1', unit: 'ZZ', unitPrice: '9000' }],
      });
      expect(landed.status).toBe(403);
      expect(landed.message).toContain('administrador');

      // Nada de lo rechazado dejó rastro: mismo costo, mismo estado y un solo movimiento.
      const untouched = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
      expect(untouched).toMatchObject({
        status: 'OPEN',
        unitCostPerKg: '4.0000',
        availableKg: '5000.000',
      });
      expect(await coilMovements(api, coil.id)).toHaveLength(1);
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

  test('un vendedor ve las cantidades del inventario pero ningún costo de compra (§3.4)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const vendedor = await apiAs(baseURL!, await createUser(api, 'VENDEDOR'));
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E que cotiza el vendedor',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const coil = coils[0]!;

      // RF-51: ve el stock de la línea, no lo que costó comprarlo.
      const summary = await getJson<SummaryDto>(
        vendedor,
        `/api/inventory/summary?businessLine=${LINE}`,
      );
      const row = summary.coils.find((r) => r.key === coil.typeKey);
      expect(row, `El inventario no muestra el tipo ${coil.typeKey}`).toBeDefined();
      expect(row!.qty).toBe('5000.000');
      expect(row!.itemCount).toBe(1);
      expect(row!.avgCostPen).toBeNull();
      expect(row!.totalValuePen).toBeNull();
      expect(summary.totalValuePen).toBeNull();

      // RF-53: lo mismo en el kardex del ítem, incluido el promedio del saldo corrido.
      const movements = await getJson<MovementDto[]>(
        vendedor,
        `/api/inventory/movements?itemType=COIL&itemId=${coil.id}`,
      );
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        type: 'IN',
        qty: '5000.000',
        unit: 'KGM',
        balanceQty: '5000.000',
        unitCost: null,
        totalCost: null,
        balanceAvgCost: null,
      });

      // El mismo movimiento sí lleva costos para el administrador: los campos van en
      // `null` por rol, no porque el kardex esté vacío.
      const asAdmin = await coilMovements(api, coil.id);
      expect(asAdmin[0]).toMatchObject({
        unitCost: '4.0000',
        totalCost: '20000.0000',
        balanceAvgCost: '4.0000',
      });

      // Y el detalle de la bobina, que lleva el costo de compra por kilo, le está
      // cerrado por completo (§3.4).
      const denied = await vendedor.get(`/api/coils/${coil.id}`);
      expect(denied.status()).toBe(403);
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

  test('una bobina cerrada no se puede partir hasta que se la reabre (RF-19)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';
    let splitId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E que se guarda cerrada',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const coil = coils[0]!;

      const closed = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
        status: 'CLOSED',
        reason: 'Se reserva para el pedido del mes que viene',
      });
      expect(closed.status).toBe('CLOSED');
      // Cerrarla no toca el kardex: conserva sus kilos, solo que no se operan.
      expect(closed.availableKg).toBe('5000.000');

      const splitBody = {
        kerfLossMm: '0',
        children: [
          { widthMm: '600', count: 1 },
          { widthMm: '560', count: 1 },
        ],
      };
      const blocked = await postExpectingError(api, `/api/coils/${coil.id}/split`, splitBody);
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('cerrada');
      expect(await getJson<SplitDto[]>(api, `/api/coils/${coil.id}/splits`)).toHaveLength(0);
      expect(await coilMovements(api, coil.id)).toHaveLength(1);

      // Cerrar dos veces tampoco es un no-op silencioso: el API lo dice.
      const twice = await postExpectingError(api, `/api/coils/${coil.id}/status`, {
        status: 'CLOSED',
      });
      expect(twice.status).toBe(400);
      expect(twice.message).toContain('ya está cerrada');

      const reopened = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
        status: 'OPEN',
      });
      expect(reopened.status).toBe('OPEN');

      const children = await postJson<CoilDto[]>(api, `/api/coils/${coil.id}/split`, splitBody);
      expect(children).toHaveLength(2);
      const splits = await getJson<SplitDto[]>(api, `/api/coils/${coil.id}/splits`);
      splitId = splits[0]!.id;
      expect(splits[0]!.status).toBe('ACTIVE');
    } finally {
      if (isProduction) {
        if (splitId) {
          await api
            .post(`/api/coils/splits/${splitId}/revert`, {
              data: { reason: 'Limpieza de prueba E2E' },
            })
            .catch(() => undefined);
        }
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
          finish,
        });
      }
    }
  });

  test('cambiar el costo de una bobina recuesta su ingreso con reversa y falla si ya tiene movimientos (RF-20, D-045)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let purchaseId = '';
    let coilId = '';

    try {
      const { purchase, coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E con precio mal facturado',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      purchaseId = purchase.id;
      const coil = coils[0]!;
      coilId = coil.id;

      const reason = 'El proveedor emitió una nota de débito por el precio por kilo';
      const recosted = await patchJson<CoilDto>(api, `/api/coils/${coil.id}`, {
        unitCostPerKg: '4.8',
        reason,
      });
      expect(recosted).toMatchObject({
        unitCostPerKg: '4.8000',
        totalCost: '24000.0000',
        totalCostPen: '24000.0000',
        availableKg: '5000.000',
      });

      // D-045: el kardex es append-only, así que recostear es reversa + nuevo ingreso,
      // nunca un UPDATE sobre el movimiento original.
      const movements = await coilMovements(api, coil.id);
      expect(movements).toHaveLength(3);
      expect(movements[0]).toMatchObject({
        type: 'IN',
        refType: 'PURCHASE',
        unitCost: '4.0000',
        totalCost: '20000.0000',
        reversedById: movements[1]!.id,
      });
      expect(movements[1]).toMatchObject({
        type: 'OUT',
        refType: 'PURCHASE',
        qty: '5000.000',
        totalCost: '20000.0000',
        reversalOfId: movements[0]!.id,
        notes: reason,
        balanceQty: '0.000',
      });
      expect(movements[2]).toMatchObject({
        type: 'IN',
        refType: 'PURCHASE',
        refId: purchase.id,
        qty: '5000.000',
        unitCost: '4.8000',
        totalCost: '24000.0000',
        notes: reason,
        reversalOfId: null,
        balanceQty: '5000.000',
      });

      const balance = await coilBalance(api, coil.id);
      expect(balance).toMatchObject({
        qty: '5000.000',
        avgCost: '4.8000',
        totalValue: '24000.0000',
      });

      // Con un movimiento posterior vivo, recostear reescribiría hacia atrás un promedio
      // que ya valorizó otra operación: el API corta y nombra lo que lo bloquea.
      await postJson<CoilDto>(api, `/api/coils/${coil.id}/scrap`, {
        qtyKg: '100',
        reason: 'Óxido en la punta',
      });
      const blocked = await patchExpectingError(api, `/api/coils/${coil.id}`, {
        unitCostPerKg: '5',
        reason: 'Segundo ajuste de precio',
      });
      expect(blocked.status).toBe(400);
      expect(blocked.message).toContain('posterior');
      expect(blocked.message).toContain('SCRAP');

      // El costo no se movió y el intento fallido no dejó movimientos a medias.
      expect((await getJson<CoilDto>(api, `/api/coils/${coil.id}`)).unitCostPerKg).toBe('4.8000');
      expect(await coilMovements(api, coil.id)).toHaveLength(4);
    } finally {
      if (isProduction) {
        // La merma se anula para dejar el saldo como estaba; el recosteo, en cambio, es
        // parte del kardex y se queda (§3.2).
        const scrap = coilId
          ? (await coilMovements(api, coilId).catch(() => [] as MovementDto[])).find(
              (m) => m.refType === 'SCRAP' && !m.reversalOfId && !m.reversedById,
            )
          : undefined;
        if (scrap) {
          await api
            .post(`/api/coils/scraps/${scrap.id}/cancel`, {
              data: { reason: 'Limpieza de prueba E2E' },
            })
            .catch(() => undefined);
        }
        await deactivateTrail(api, {
          purchaseIds: purchaseId ? [purchaseId] : [],
          supplierId: supplier.id,
          finish,
        });
      }
    }
  });

  test('anular una bobina sin movimientos revierte su ingreso y una hija de partido no se anula (RF-21)', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const supplier = await createSupplier(api);
    const finish = await createFinish(api);
    let splitId = '';

    try {
      const { coils } = await receivedCoilPurchase(api, {
        supplier,
        finish,
        lines: [
          {
            description: 'Bobina E2E que nunca llegó',
            weightKg: '5000',
            widthMm: '1220',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
          {
            description: 'Bobina E2E que se parte',
            weightKg: '3000',
            widthMm: '1000',
            thicknessMm: '2',
            unitPricePerKg: '4',
          },
        ],
      });
      const missing = coils.find((c) => c.weightKg === '5000.000');
      const toSplit = coils.find((c) => c.weightKg === '3000.000');
      expect(missing, 'No se creó la bobina de 5 000 kg').toBeDefined();
      expect(toSplit, 'No se creó la bobina de 3 000 kg').toBeDefined();

      // RF-21: sin más movimientos que su ingreso, la bobina se anula revirtiéndolo.
      const cancelled = await postJson<CoilDto>(api, `/api/coils/${missing!.id}/cancel`, {
        reason: 'La bobina no llegó en el camión y el proveedor la desfacturó',
      });
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.availableKg).toBe('0.000');

      const movements = await coilMovements(api, missing!.id);
      expect(movements).toHaveLength(2);
      expect(movements[1]).toMatchObject({
        type: 'OUT',
        refType: 'PURCHASE',
        qty: '5000.000',
        totalCost: '20000.0000',
        reversalOfId: movements[0]!.id,
        balanceQty: '0.000',
      });
      expect((await coilBalance(api, missing!.id)).qty).toBe('0.000');

      // Anularla dos veces no puede sacar los mismos kilos otra vez.
      const twice = await postExpectingError(api, `/api/coils/${missing!.id}/cancel`, {
        reason: 'Intento repetido de la misma anulación',
      });
      expect(twice.status).toBe(400);
      expect(twice.message).toContain('ya está anulada');

      // Una hija de un partido no se anula sola: se revierte el partido entero (RF-16),
      // o su peso no volvería nunca a la madre.
      const children = await postJson<CoilDto[]>(api, `/api/coils/${toSplit!.id}/split`, {
        kerfLossMm: '0',
        children: [
          { widthMm: '500', count: 1 },
          { widthMm: '480', count: 1 },
        ],
      });
      expect(children).toHaveLength(2);
      splitId = (await getJson<SplitDto[]>(api, `/api/coils/${toSplit!.id}/splits`))[0]!.id;

      const child = await postExpectingError(api, `/api/coils/${children[0]!.id}/cancel`, {
        reason: 'Intento de anular una hija suelta',
      });
      expect(child.status).toBe(400);
      expect(child.message).toContain('revierte el partido');
      expect((await getJson<CoilDto>(api, `/api/coils/${children[0]!.id}`)).status).toBe('OPEN');
    } finally {
      if (isProduction) {
        if (splitId) {
          await api
            .post(`/api/coils/splits/${splitId}/revert`, {
              data: { reason: 'Limpieza de prueba E2E' },
            })
            .catch(() => undefined);
        }
        // La compra ya no admite anulación: una de sus bobinas quedó anulada y su
        // ingreso revertido. Los maestros sí quedan desactivados.
        await deactivateTrail(api, { supplierId: supplier.id, finish });
      }
    }
  });
});
