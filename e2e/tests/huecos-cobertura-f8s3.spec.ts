import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminApi, adminCredentials, createUser, getJson, postJson } from '../helpers/api';
import { apiAs, balanceOf, type ProductionOrderDto } from '../helpers/production';
import { createCustomer, pdfText, queueOf, setOrderPriority } from '../helpers/sales';
import {
  createRoofingProduct,
  mountCoil,
  pieces,
  purgeRoofingTrail,
  quoteAndOrderLines,
  setupRoofingScenario,
} from '../helpers/roofing';
import { rowAction } from '../helpers/ui';

/**
 * F8-S3 — huecos de cobertura que los specs de la sesión dejaron sin mirar.
 *
 * 1. UI del borrador (D-191): corregir y quitar una fila; ejecutar apagado mientras se corrige.
 * 2. UI del fallo al ejecutar: el mensaje nombra la fila y el borrador y el kardex quedan intactos.
 * 3. Roles: VENDEDOR lee la cola pero no toca el borrador; SUPERVISOR_PLANTA ejecuta pero no
 *    prioriza.
 * 4. La cola excluye anuladas y cerradas; bajar la única bobina sin reportes la devuelve a la cola.
 * 5. La hoja de planta de un pedido con una OP priorizada (D-189).
 * 6. Montar varias (D-192) con más de 20 ids o con un id repetido: 400 y ninguna montada.
 *
 * Aritmética: 1 000 mm × 0.50 mm, densidad 8.0 y el 1 % de D-165 ⇒ 4.04 kg por metro.
 *
 * Escribe (compras, bobinas, pedidos, producción): nunca contra producción (D-126).
 */

const isProduction = !!process.env.E2E_BASE_URL;
test.skip(isProduction, 'Crea compras, bobinas y producción: nunca contra producción (D-126).');
test.describe.configure({ timeout: 240_000 });

type Trail = Parameters<typeof purgeRoofingTrail>[1];

interface DraftDto {
  id: string;
  rowNumber: number;
  coilId: string;
  pieces: { lengthMm: string; qty: number }[];
  meters: string;
  consumedKg: string | null;
}

const draftsPath = (opId: string) => `/api/production/roofing/${opId}/drafts`;

async function loginAsAdmin(page: Page) {
  const { email, password } = adminCredentials();
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page).toHaveURL(/\/(cambiar-contrasena)?$/, { timeout: 60_000 });
}

/** Un pedido de una línea (10 × 4 m = 40 m) con su OP en cola y una bobina de 2 000 kg. */
async function setupSingle(api: APIRequestContext) {
  const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
  const customer = await createCustomer(api);
  const { quotation, order } = await quoteAndOrderLines(api, {
    customerId: customer.id,
    lines: [{ productId: scenario.product.id, rows: pieces([4, 10]) }],
  });
  const opId = order.reservations[0]!.productionOrderId!;
  const op = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
  const trail: Trail = {
    supplierId: scenario.supplier.id,
    finishId: scenario.finish.id,
    colorId: scenario.color.id,
    productIds: [scenario.product.id],
    coilIds: [scenario.coil.id],
    purchaseIds: [scenario.purchaseId],
    productionOrderIds: [opId],
    orderIds: [order.id],
    quotationIds: [quotation.id],
  };
  return { scenario, order, opId, opCode: op.code, trail };
}

test.describe('F8-S3 — huecos de cobertura', () => {
  test('modelo M: un borrador viejo con dos filas de la misma bobina se ve como un bloque y al corregirlo queda una fila (cc35)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const { scenario, order, opId, opCode, trail } = await setupSingle(api);
    try {
      await mountCoil(api, opId, { coilId: scenario.coil.id });
      await postJson(api, draftsPath(opId), { pieces: pieces([4, 3]) }); // 12 m
      await postJson(api, draftsPath(opId), { pieces: pieces([4, 2]), consumedKg: '40' }); // 8 m

      await loginAsAdmin(page);
      await page.goto(`/planta?pedido=${order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      const panel = page.getByRole('tabpanel', { name: opCode });
      const block = panel.getByTestId(`bloque-${scenario.coil.code}`);
      // Las dos filas son un solo bloque: 3 + 2 planchas de 4 m y los 40 kg declarados.
      await expect(block.getByLabel(/Planchas del corte 1 de/)).toHaveValue('5', {
        timeout: 60_000,
      });
      await expect(block.getByLabel(/kg consumidos de/)).toHaveValue('40.000');
      // Lo que se escribía en filas ya no tiene botones de borrador.
      await expect(
        panel.getByRole('button', { name: /Agregar al borrador|Ejecutar el borrador/ }),
      ).toHaveCount(0);

      // Corregir el bloque deja una sola fila con lo nuevo.
      await block.getByLabel(/Planchas del corte 1 de/).fill('7'); // 28 m de 40
      await expect(panel.getByText('Todo lo escrito está guardado')).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(async () =>
          (await getJson<DraftDto[]>(api, draftsPath(opId))).map((d) => [d.meters, d.consumedKg]),
        )
        .toEqual([['28.000', '40.000']]);

      // Nada de esto tocó el kardex ni generó reportes.
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('2000.000');
      const after = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(after.reports).toHaveLength(0);
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('modelo M: si otro reporte ocupó el plan, registrar avisa en el bloque de la bobina y el borrador y el kardex quedan como estaban (cc35)', async ({
    page,
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const { scenario, order, opId, opCode, trail } = await setupSingle(api);
    try {
      await mountCoil(api, opId, { coilId: scenario.coil.id });
      await postJson(api, draftsPath(opId), { pieces: pieces([4, 5]) }); // 20 m
      await postJson(api, draftsPath(opId), { pieces: pieces([4, 5]) }); // 20 m
      // Un reporte directo de 8 m ocupa el plan por debajo del borrador: la fila 2 ya no entra.
      await postJson(api, `/api/production/roofing/${opId}/report`, { pieces: pieces([4, 2]) });

      await loginAsAdmin(page);
      await page.goto(`/planta?pedido=${order.id}`);
      await expect(page.getByRole('heading', { name: `Producir ${order.code}` })).toBeVisible({
        timeout: 60_000,
      });
      const panel = page.getByRole('tabpanel', { name: opCode });
      const block = panel.getByTestId(`bloque-${scenario.coil.code}`);
      await expect(block.getByLabel(/Planchas del corte 1 de/)).toHaveValue('10', {
        timeout: 60_000,
      });

      await panel.getByRole('button', { name: `Registrar producción de ${opCode}` }).click();
      // «Fila 2: …» se muestra en el bloque de su bobina, sin el número de fila.
      // cc38 (D-574): 8 + 20 + 20 = 48 contra 40.
      await expect(block.getByRole('alert')).toContainText(
        'Excede el plan en 8.000 m · ajusta el plan',
        {
          timeout: 60_000,
        },
      );

      // El borrador sigue entero en el servidor; nada se grabó.
      expect(await getJson<DraftDto[]>(api, draftsPath(opId))).toHaveLength(2);
      const after = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(after.reports).toHaveLength(1);
      expect((await balanceOf(api, 'COIL', scenario.coil.id)).qty).toBe('1967.680');
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('roles: VENDEDOR lee la cola pero no toca el borrador; SUPERVISOR_PLANTA ejecuta el borrador pero no prioriza', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const { scenario, opId, trail } = await setupSingle(api);
    const seller = await createUser(api, 'VENDEDOR');
    const supervisor = await createUser(api, 'SUPERVISOR_PLANTA');
    let sellerApi: APIRequestContext | null = null;
    let supervisorApi: APIRequestContext | null = null;
    try {
      sellerApi = await apiAs(baseURL!, seller);
      supervisorApi = await apiAs(baseURL!, supervisor);

      const queue = await sellerApi.get('/api/production/roofing/queue');
      expect(queue.status()).toBe(200);
      const entries = (await queue.json()) as { orderId: string }[];
      // S3c: El VENDEDOR ya no ve OPs ajenas en su cola.
      expect(entries.some((e) => e.orderId === opId)).toBe(false);

      // Prioridad: solo ADMINISTRADOR; el supervisor recibe 403 y la OP sigue sin prioridad.
      const supPriority = await supervisorApi.patch(`/api/production/roofing/${opId}/priority`, {
        data: { priority: true, reason: 'Intento de un supervisor' },
      });
      expect(supPriority.status()).toBe(403);
      expect((await queueOf(api)).find((q) => q.orderId === opId)?.priority).toBe(false);

      await mountCoil(api, opId, { coilId: scenario.coil.id });

      const sellerDraft = await sellerApi.post(draftsPath(opId), {
        data: { pieces: pieces([4, 2]) },
      });
      expect(sellerDraft.status()).toBe(403);
      const sellerCommit = await sellerApi.post(`${draftsPath(opId)}/commit`, {
        data: { idempotencyKey: randomUUID() },
      });
      expect(sellerCommit.status()).toBe(403);
      expect(await getJson<DraftDto[]>(api, draftsPath(opId))).toEqual([]);

      // SUPERVISOR_PLANTA: borrador y ejecución sí.
      const supDraft = await supervisorApi.post(draftsPath(opId), {
        data: { pieces: pieces([4, 2]) },
      });
      expect(supDraft.ok(), await supDraft.text()).toBe(true);
      const supCommit = await supervisorApi.post(`${draftsPath(opId)}/commit`, {
        data: { idempotencyKey: randomUUID() },
      });
      expect(supCommit.ok(), await supCommit.text()).toBe(true);
      expect((await balanceOf(api, 'PRODUCT', scenario.product.id)).qty).toBe('8.000');
    } finally {
      await sellerApi?.dispose();
      await supervisorApi?.dispose();
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('la cola excluye la OP anulada y la cerrada; bajar la única bobina sin reportes la devuelve a DRAFT y a la cola', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const scenario = await setupRoofingScenario(api, { weightKg: '2000' });
    const { product: second } = await createRoofingProduct(api, {
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
    });
    const { product: third } = await createRoofingProduct(api, {
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
    });
    const customer = await createCustomer(api);
    const trail: Trail = {
      supplierId: scenario.supplier.id,
      finishId: scenario.finish.id,
      colorId: scenario.color.id,
      productIds: [scenario.product.id, second.id, third.id],
      coilIds: [scenario.coil.id],
      purchaseIds: [scenario.purchaseId],
      productionOrderIds: [],
      orderIds: [],
      quotationIds: [],
    };
    try {
      const { quotation, order } = await quoteAndOrderLines(api, {
        customerId: customer.id,
        lines: [
          { productId: scenario.product.id, rows: pieces([4, 5]) },
          { productId: second.id, rows: pieces([4, 5]) },
          { productId: third.id, rows: pieces([4, 5]) },
        ],
      });
      trail.quotationIds = [quotation.id];
      trail.orderIds = [order.id];
      const [cancelId, closeId, releaseId] = order.reservations.map((r) => r.productionOrderId!);
      trail.productionOrderIds = [cancelId!, closeId!, releaseId!];

      const inQueue = async () => new Set((await queueOf(api)).map((q) => q.orderId));
      let ids = await inQueue();
      expect([cancelId, closeId, releaseId].every((id) => ids.has(id!))).toBe(true);

      // Montar y bajar sin reportar: vuelve a DRAFT y a la cola.
      const mounted = await mountCoil(api, releaseId!, { coilId: scenario.coil.id });
      expect(mounted.status).toBe('IN_PROGRESS');
      expect((await inQueue()).has(releaseId!)).toBe(false);
      const consumption = mounted.consumptions.find((c) => c.releasedAt === null)!;
      const released = await postJson<ProductionOrderDto>(
        api,
        `/api/production/roofing/${releaseId}/coils/${consumption.id}/release`,
      );
      expect(released.status).toBe('DRAFT');
      expect((await inQueue()).has(releaseId!)).toBe(true);

      // Anulada: sale de la cola.
      await postJson(api, `/api/production/roofing/${cancelId}/cancel`, {
        reason: 'E2E: la cola no muestra anuladas',
      });

      // Cerrada: se produce el plan entero y se cierra en el mismo commit.
      await mountCoil(api, closeId!, { coilId: scenario.coil.id });
      await postJson(api, draftsPath(closeId!), { pieces: pieces([4, 5]) });
      const closed = await postJson<ProductionOrderDto>(api, `${draftsPath(closeId!)}/commit`, {
        close: true,
        idempotencyKey: randomUUID(),
      });
      expect(closed.status).toBe('CLOSED');

      ids = await inQueue();
      expect(ids.has(cancelId!)).toBe(false);
      expect(ids.has(closeId!)).toBe(false);
      expect(ids.has(releaseId!)).toBe(true);
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('la hoja de planta de un pedido con una OP priorizada responde 200 y lleva la prioridad con su OP', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const { order, opId, opCode, trail } = await setupSingle(api);
    try {
      const path = `/api/sales/orders/${order.id}/pdf-planta`;
      const plain = await api.get(path);
      expect(plain.status()).toBe(200);
      expect(pdfText(await plain.body())).not.toContain('PRIORIDAD');

      await setOrderPriority(api, opId, { priority: true, reason: 'Obra con grua alquilada' });
      const sheet = await api.get(path);
      expect(sheet.status()).toBe(200);
      expect(sheet.headers()['content-type']).toContain('application/pdf');
      const body = await sheet.body();
      expect(body.subarray(0, 4).toString()).toBe('%PDF');
      const text = pdfText(body);
      expect(text).toContain('PRIORIDAD');
      expect(text).toContain(`${opCode}: Obra con grua alquilada`);
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });

  test('montar varias con más de 20 bobinas o con una repetida responde 400 y no monta ninguna', async ({
    baseURL,
  }) => {
    const api = await adminApi(baseURL!);
    const { scenario, opId, trail } = await setupSingle(api);
    try {
      const coilsPath = `/api/production/roofing/${opId}/coils`;
      // El pipe de Zod responde `message: 'Datos inválidos'` y el detalle por campo en `errors`.
      const coilIdsErrors = async (coilIds: string[]) => {
        const res = await api.post(coilsPath, { data: { coilIds } });
        const body = (await res.json()) as { errors?: { coilIds?: string[] } };
        return { status: res.status(), errors: (body.errors?.coilIds ?? []).join(' | ') };
      };

      const tooMany = await coilIdsErrors([
        scenario.coil.id,
        ...Array.from({ length: 20 }, () => randomUUID()),
      ]);
      expect(tooMany.status).toBe(400);
      expect(tooMany.errors).toMatch(/Como máximo 20 bobinas a la vez/);

      const repeated = await coilIdsErrors([scenario.coil.id, scenario.coil.id]);
      expect(repeated.status).toBe(400);
      expect(repeated.errors).toMatch(/Una bobina aparece dos veces/);

      const untouched = await getJson<ProductionOrderDto>(api, `/api/production/${opId}`);
      expect(untouched.status).toBe('DRAFT');
      expect(untouched.consumptions.filter((c) => c.releasedAt === null)).toHaveLength(0);

      // Y la bobina sigue libre para montarse bien.
      const ok = await postJson<ProductionOrderDto>(api, coilsPath, {
        coilIds: [scenario.coil.id],
      });
      expect(ok.consumptions.filter((c) => c.releasedAt === null)).toHaveLength(1);
    } finally {
      await purgeRoofingTrail(api, trail);
      await api.dispose();
    }
  });
});
