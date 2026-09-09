import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  adminApi,
  closeCoilKeepingStock,
  createFinish,
  createSupplier,
  getItems,
  getJson,
  postJson,
  type CreatedFinish,
  type CreatedSupplier,
} from '../helpers/api';
import { today } from '../helpers/production';

/**
 * **D-164 — liquidación del remanente al cerrar una bobina (RF-19).**
 *
 * Lo que estos casos fijan es que cerrar una bobina dejó de ser un cambio de estado sin
 * consecuencias. Antes de D-164 el saldo teórico que quedaba en `inventory_balances` se
 * quedaba ahí para siempre: la bobina cerrada desaparecía de producción y del partido, pero
 * **seguía sumando kilos y valor al inventario valorizado** de material que ya no existe, y
 * nada avisaba. La única herramienta era la merma de RF-17, un acto aparte y sin relación con
 * el cierre, que nadie recordaba usar.
 *
 * Los escenarios cubren el ciclo entero: el cierre que liquida todo, el que liquida solo la
 * diferencia, el que no tiene nada que liquidar, el que se niega a liquidar en silencio, el
 * conteo que da de más (sobre saldo cero y sobre saldo vivo, que se valorizan distinto), la
 * reversa al reabrir, el ajuste que queda **inerte** cuando algo movió la bobina después del
 * cierre —el defecto que encontró la revisión— y los kilos imposibles que corta el schema.
 *
 * Escribe kardex (append-only, §3.2), así que sigue la convención de Fase 2b: contra
 * producción solo corre si se pide explícitamente (D-024, regla dura 9).
 */
const isProduction = !!process.env.E2E_BASE_URL;
const skipWrites = isProduction && process.env.E2E_ALLOW_WRITES !== '1';

/** Línea con inventario (`STOCK`), igual que Fase 2b. */
const LINE = 'drywall';

interface CoilDto {
  id: string;
  code: string;
  status: string;
  availableKg: string;
  avgCostPen: string;
}

interface MovementDto {
  id: string;
  type: string;
  qty: string;
  unitCost: string | null;
  totalCost: string | null;
  refType: string;
  notes: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  balanceQty: string | null;
}

interface PurchaseDto {
  id: string;
  status: string;
}

/** Correlativo único: el índice (proveedor, tipo, serie, número) no se resetea fuera de CI. */
function uniqueDocumentNumber(): string {
  return String(Date.now()).slice(-9);
}

/**
 * Compras creadas por los casos, para poder anularlas al terminar contra producción. Vive al
 * lado de `buyCoil` y no en el `describe` para que se anote sola: un caso nuevo que compre una
 * bobina y se olvide de registrarla dejaría rastro en producción sin que nada avise.
 */
const purchaseIds: string[] = [];

/** Una bobina abierta de `weightKg` kilos a `unitPrice` por kilo, ya ingresada al kardex. */
async function buyCoil(
  api: APIRequestContext,
  input: { supplier: CreatedSupplier; finish: CreatedFinish; weightKg: string; unitPrice: string },
): Promise<{ coil: CoilDto; purchaseId: string }> {
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
    items: [
      {
        description: 'Bobina E2E para el cierre con remanente (D-164)',
        qty: input.weightKg,
        unit: 'KGM',
        unitPrice: input.unitPrice,
        finishId: input.finish.id,
        widthMm: '1220',
        thicknessMm: '0.50',
        // D-117: sin esto la bobina nace CLOSED y no se puede operar.
        coilStatus: 'OPEN',
      },
    ],
  });
  await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/receive`);
  purchaseIds.push(purchase.id);
  const coils = await getItems<CoilDto & { purchaseId: string | null }>(
    api,
    `/api/coils?supplierId=${input.supplier.id}`,
  );
  const coil = coils.find((c) => c.purchaseId === purchase.id);
  expect(coil, 'La compra no dejó ninguna bobina').toBeDefined();
  return { coil: coil!, purchaseId: purchase.id };
}

/** El último movimiento del kardex de la bobina, que es el que el cierre acaba de emitir. */
async function lastMovement(api: APIRequestContext, coilId: string): Promise<MovementDto> {
  const rows = await movements(api, coilId);
  const last = rows.at(-1);
  expect(last, `La bobina ${coilId} no tiene movimientos`).toBeDefined();
  return last!;
}

/** Kardex de la bobina en orden cronológico (el API lo devuelve al revés, para la vista). */
async function movements(api: APIRequestContext, coilId: string): Promise<MovementDto[]> {
  const rows = await getItems<MovementDto>(
    api,
    `/api/inventory/movements?itemType=COIL&itemId=${coilId}`,
  );
  return rows.reverse();
}

/**
 * El error de un `POST /coils/:id/status` que se espera que falle.
 *
 * `message` junta el mensaje **y los errores por campo**: `ZodValidationPipe` no pone el
 * detalle en `message` —ahí manda un `"Datos inválidos"` genérico— sino en `errors`, así que
 * un caso que verifica un `superRefine` del schema no puede mirar solo `message`. Aplanar los
 * dos deja las aserciones iguales para los rechazos del schema y los del servicio.
 */
async function closeExpectingError(
  api: APIRequestContext,
  coilId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; message: string }> {
  const res = await api.post(`/api/coils/${coilId}/status`, { data: body });
  const parsed = (await res.json()) as {
    message?: string | string[];
    errors?: Record<string, string[]>;
  };
  const message = Array.isArray(parsed.message) ? parsed.message.join(' ') : (parsed.message ?? '');
  const fieldErrors = Object.values(parsed.errors ?? {}).flat();
  return { status: res.status(), message: [message, ...fieldErrors].join(' ') };
}

test.describe('D-164 — el cierre de una bobina liquida su remanente', () => {
  test.skip(skipWrites, 'Escribe kardex: contra producción solo con E2E_ALLOW_WRITES=1 (D-024)');

  let api: APIRequestContext;
  let supplier: CreatedSupplier;
  let finish: CreatedFinish;

  test.beforeAll(async ({ baseURL }) => {
    api = await adminApi(baseURL!);
    supplier = await createSupplier(api);
    finish = await createFinish(api);
  });

  test.afterAll(async () => {
    // Misma convención que Fase 2b: contra producción se deshace lo que el dominio deja
    // deshacer y se desactivan los maestros creados, de modo que el rastro quede inerte. Lo
    // que el kardex no deja borrar (los movimientos y sus reversas) queda visible, como
    // corresponde a §3.2. En local no hace falta: la base se vacía en cada corrida.
    if (isProduction) {
      for (const purchaseId of purchaseIds) {
        await api
          .post(`/api/purchases/${purchaseId}/cancel`, {
            data: { reason: 'Limpieza de prueba E2E' },
          })
          .catch(() => undefined);
      }
      await api
        .patch(`/api/suppliers/${supplier.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      await api
        .patch(`/api/finishes/${finish.id}`, { data: { isActive: false } })
        .catch(() => undefined);
      // D-037: la primera bobina de cada tipo crea un producto de trading `BOB{acabado}{espesor}`.
      const products = await getItems<{ id: string; sku: string }>(
        api,
        '/api/catalog?businessLine=trading',
      ).catch(() => []);
      for (const product of products.filter((p) => p.sku.startsWith(`BOB${finish.code}`))) {
        await api
          .patch(`/api/catalog/${product.id}`, { data: { isActive: false } })
          .catch(() => undefined);
      }
    }
    await api.dispose();
  });

  test('el remanente sale del kardex como ajuste de cierre, no como consumo', async () => {
    const { coil } = await buyCoil(api, {
      supplier,
      finish,
      weightKg: '1000',
      unitPrice: '4',
    });
    // La bobina se gasta casi entera y queda un saldo teórico de 40 kg que planta dice que
    // ya no existe: el rollo se terminó. Es el caso que motivó la decisión.
    await postJson(api, `/api/coils/${coil.id}/scrap`, {
      qtyKg: '960',
      reason: 'Consumo de la corrida (prueba E2E)',
    });
    const before = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
    expect(before.availableKg).toBe('40.000');
    expect(before.avgCostPen).toBe('4.0000');

    const closed = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
      status: 'CLOSED',
      physicalKg: '0',
      reason: 'El rollo se terminó en la corrida del martes (prueba E2E)',
    });
    expect(closed.status).toBe('CLOSED');
    // Lo que antes de D-164 no pasaba: el saldo queda en cero y deja de valer en el
    // inventario valorizado. Ese era el defecto entero, en una línea.
    expect(closed.availableKg).toBe('0.000');

    const kardex = await movements(api, coil.id);
    const adjustment = kardex.at(-1)!;
    expect(adjustment.refType).toBe('CLOSE_ADJUSTMENT');
    expect(adjustment.type).toBe('OUT');
    expect(adjustment.qty).toBe('40.000');
    // Sale al costo promedio vigente (D-028/D-040), como toda salida.
    expect(adjustment.totalCost).toBe('160.0000');
    expect(adjustment.balanceQty).toBe('0.000');
    expect(adjustment.notes).toContain('se terminó');
    // Y es distinguible del consumo: el `refType` propio es lo que permite medir merma
    // ANORMAL aparte del 1 % que D-165 absorbió en la densidad estándar.
    expect(kardex.filter((m) => m.refType === 'SCRAP')).toHaveLength(1);
    expect(kardex.filter((m) => m.refType === 'CLOSE_ADJUSTMENT')).toHaveLength(1);
  });

  test('cerrar sin decir qué queda es un 400 que nombra el remanente', async () => {
    const { coil } = await buyCoil(api, { supplier, finish, weightKg: '500', unitPrice: '4' });

    // Sin `physicalKg` no se cierra: dejarlo opcional con default cero convertiría un olvido
    // en una baja de inventario silenciosa, que es lo que la decisión viene a cerrar.
    const sinDeclarar = await closeExpectingError(api, coil.id, { status: 'CLOSED' });
    expect(sinDeclarar.status).toBe(400);
    expect(sinDeclarar.message).toContain('500.000');

    // Y liquidar exige motivo, igual que cualquier otra merma (RF-17).
    const sinMotivo = await closeExpectingError(api, coil.id, {
      status: 'CLOSED',
      physicalKg: '0',
    });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.message).toContain('motivo');

    // Nada de eso movió el kardex ni el estado.
    const intacta = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
    expect(intacta.status).toBe('OPEN');
    expect(intacta.availableKg).toBe('500.000');
    expect(await movements(api, coil.id)).toHaveLength(1);
  });

  test('cerrar declarando el saldo entero no mueve el kardex', async () => {
    const { coil } = await buyCoil(api, { supplier, finish, weightKg: '300', unitPrice: '4' });

    // Cerrar sin liquidar sigue siendo legítimo: es sacar de producción un rollo que se
    // guarda. Lo que D-164 impide es que eso ocurra **por defecto** y sin decirlo.
    const closed = await closeCoilKeepingStock(api, coil.id, 'Se guarda entero (prueba E2E)');
    expect(closed.status).toBe('CLOSED');
    expect(closed.availableKg).toBe('300.000');
    expect(await movements(api, coil.id)).toHaveLength(1);

    // Y reabrirla, al no haber ajuste que deshacer, tampoco pide motivo ni mueve nada.
    const reopened = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
      status: 'OPEN',
    });
    expect(reopened.status).toBe('OPEN');
    expect(await movements(api, coil.id)).toHaveLength(1);
  });

  test('el conteo que da de más entra al kardex como sobrante', async () => {
    const { coil } = await buyCoil(api, { supplier, finish, weightKg: '200', unitPrice: '4' });
    await postJson(api, `/api/coils/${coil.id}/scrap`, {
      qtyKg: '200',
      reason: 'Se dio por consumida entera (prueba E2E)',
    });
    expect((await getJson<CoilDto>(api, `/api/coils/${coil.id}`)).availableKg).toBe('0.000');

    // Al cerrarla, planta encuentra 12 kg que el kardex no conocía. Da de alta material, así
    // que exige motivo igual que la baja.
    const closed = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
      status: 'CLOSED',
      physicalKg: '12',
      reason: 'Quedaban 12 kg que la corrida no descontó (prueba E2E)',
    });
    expect(closed.status).toBe('CLOSED');
    expect(closed.availableKg).toBe('12.000');

    const adjustment = (await movements(api, coil.id)).at(-1)!;
    expect(adjustment.refType).toBe('CLOSE_ADJUSTMENT');
    expect(adjustment.type).toBe('IN');
    expect(adjustment.qty).toBe('12.000');
    // Sobre un saldo en cero el promedio vigente no dice nada, así que entra al costo del
    // documento: sin esto, los kilos volverían al inventario **sin valor**.
    expect(adjustment.unitCost).toBe('4.0000');
    expect(closed.avgCostPen).toBe('4.0000');
  });

  test('reabrir devuelve el remanente con un movimiento inverso, y no por RF-18', async () => {
    const { coil } = await buyCoil(api, { supplier, finish, weightKg: '600', unitPrice: '4' });
    await postJson(api, `/api/coils/${coil.id}/scrap`, {
      qtyKg: '550',
      reason: 'Consumo de la corrida (prueba E2E)',
    });
    await postJson(api, `/api/coils/${coil.id}/status`, {
      status: 'CLOSED',
      physicalKg: '0',
      reason: 'Se cierra por error (prueba E2E)',
    });
    const adjustment = (await movements(api, coil.id)).at(-1)!;
    expect(adjustment.refType).toBe('CLOSE_ADJUSTMENT');
    expect(adjustment.qty).toBe('50.000');

    // El ajuste NO se anula por RF-18: `cancelScrap` mira el `refType` y lo rechaza, igual
    // que rechaza la merma de proceso del cierre de una OP (D-057). Que sean dos hechos
    // distintos bajo dos `refType` distintos es lo que hace posible este corte.
    const porRf18 = await api.post(`/api/coils/scraps/${adjustment.id}/cancel`, {
      data: { reason: 'Intento de anular el ajuste por el camino equivocado (prueba E2E)' },
    });
    expect(porRf18.status()).toBe(400);
    expect(await porRf18.text()).toContain('no es una merma de bobina');

    // Reabrir sin motivo tampoco: devolver kilos al kardex se explica (RF-95).
    const sinMotivo = await closeExpectingError(api, coil.id, { status: 'OPEN' });
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.message).toContain('50.000');

    const reopened = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
      status: 'OPEN',
      reason: 'Se había cerrado por error: el rollo sigue en planta (prueba E2E)',
    });
    expect(reopened.status).toBe('OPEN');
    expect(reopened.availableKg).toBe('50.000');

    const kardex = await movements(api, coil.id);
    const reversal = kardex.at(-1)!;
    expect(reversal.reversalOfId).toBe(adjustment.id);
    expect(reversal.type).toBe('IN');
    expect(reversal.qty).toBe('50.000');
    // El valor vuelve exacto: la reversa arrastra el importe del original, no el promedio
    // del momento, así que el promedio de la bobina no se contamina.
    expect(reversal.totalCost).toBe('200.0000');
    expect(reversal.balanceQty).toBe('50.000');
    // El original queda marcado como anulado y no se puede volver a deshacer.
    expect(kardex.find((m) => m.id === adjustment.id)?.reversedById).toBe(reversal.id);

    // Y volver a cerrarla liquida de nuevo, con su propio ajuste: la reapertura revierte el
    // ajuste del cierre que se está deshaciendo, no todos los de la historia de la bobina.
    await postJson(api, `/api/coils/${coil.id}/status`, {
      status: 'CLOSED',
      physicalKg: '0',
      reason: 'Ahora sí, el rollo se terminó (prueba E2E)',
    });
    const final = await lastMovement(api, coil.id);
    expect(final.refType).toBe('CLOSE_ADJUSTMENT');
    expect(final.reversalOfId).toBeNull();
    expect((await getJson<CoilDto>(api, `/api/coils/${coil.id}`)).availableKg).toBe('0.000');
  });

  test('liquida solo la diferencia cuando el rollo todavía tiene material', async () => {
    const { coil } = await buyCoil(api, { supplier, finish, weightKg: '400', unitPrice: '4' });

    // El caso del medio, que no cubrían ni el "todo" ni el "nada": planta declara 92.25 kg
    // sobre un saldo de 400, así que se liquidan 307.75 y el rollo queda con lo declarado.
    const closed = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
      status: 'CLOSED',
      physicalKg: '92.250',
      reason: 'Quedó menos de lo que decía el kardex (prueba E2E)',
    });
    expect(closed.availableKg).toBe('92.250');
    // El promedio NO se mueve: una salida sale al promedio vigente y no lo recalcula (D-028).
    expect(closed.avgCostPen).toBe('4.0000');

    const adjustment = await lastMovement(api, coil.id);
    expect(adjustment.refType).toBe('CLOSE_ADJUSTMENT');
    expect(adjustment.type).toBe('OUT');
    expect(adjustment.qty).toBe('307.750');
    expect(adjustment.totalCost).toBe('1231.0000');
    expect(adjustment.balanceQty).toBe('92.250');
  });

  test('el sobrante sobre un saldo vivo entra al promedio vigente', async () => {
    // La bobina entra con 200 kg y se consumen 100, así que declarar 130 al cerrar es un
    // sobrante de 30 sobre el saldo **y** sigue por debajo de lo que el rollo ingresó: la cota
    // física de arriba y el sobrante son dos reglas distintas y no se pisan.
    const { coil } = await buyCoil(api, { supplier, finish, weightKg: '200', unitPrice: '4' });
    await postJson(api, `/api/coils/${coil.id}/scrap`, {
      qtyKg: '100',
      reason: 'Consumo de la corrida (prueba E2E)',
    });

    // Distinto del sobrante sobre saldo cero: con kilos en stock hay promedio vigente, y la
    // entrada tiene que usarlo. Valorizarla al costo del documento movería el promedio de un
    // material que es el mismo, y ese error viaja al costeo y al piso de precio (D-163).
    const closed = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
      status: 'CLOSED',
      physicalKg: '130',
      reason: 'La balanza dio 30 kg más que el kardex (prueba E2E)',
    });
    expect(closed.availableKg).toBe('130.000');
    expect(closed.avgCostPen).toBe('4.0000');

    const adjustment = await lastMovement(api, coil.id);
    expect(adjustment.type).toBe('IN');
    expect(adjustment.qty).toBe('30.000');
    expect(adjustment.unitCost).toBe('4.0000');
  });

  test('el ajuste queda inerte si algo movió la bobina después del cierre', async () => {
    const { coil } = await buyCoil(api, { supplier, finish, weightKg: '300', unitPrice: '4' });
    await postJson(api, `/api/coils/${coil.id}/scrap`, {
      qtyKg: '250',
      reason: 'Consumo de la corrida (prueba E2E)',
    });
    await postJson(api, `/api/coils/${coil.id}/status`, {
      status: 'CLOSED',
      physicalKg: '0',
      reason: 'El rollo se terminó (prueba E2E)',
    });
    const adjustment = await lastMovement(api, coil.id);
    expect(adjustment.refType).toBe('CLOSE_ADJUSTMENT');
    expect(adjustment.qty).toBe('50.000');

    // Acá está el defecto que encontró la revisión, en su forma reproducible: si algo mueve la
    // bobina DESPUÉS del cierre —acá, anular la merma de RF-18; en el caso que reportó la
    // revisión, `revertSplit` reabriendo a la madre con un `update` directo—, el ajuste deja de
    // ser el último movimiento del kardex. Con la regla vieja ("el último CLOSE_ADJUSTMENT
    // vivo") una reapertura posterior lo adoptaba y devolvía 50 kg **de la nada**.
    //
    // Este caso es además el que descartó el primer intento de corrección: mirar el último
    // movimiento **vivo** no sirve, porque `liveMovements` anula el par merma+reversa y el
    // ajuste vuelve a quedar último. Si alguien reintroduce ese filtro, este test se cae.
    const scrap = (await movements(api, coil.id)).find((m) => m.refType === 'SCRAP')!;
    await postJson(api, `/api/coils/scraps/${scrap.id}/cancel`, {
      reason: 'La merma se había registrado por error (prueba E2E)',
    });
    const afterCancel = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
    expect(afterCancel.availableKg).toBe('250.000');

    const reopened = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
      status: 'OPEN',
      reason: 'Se reabre después de anular la merma (prueba E2E)',
    });
    expect(reopened.status).toBe('OPEN');
    // El saldo NO sube a 300: el ajuste quedó inerte y nadie inventó los 50 kg.
    expect(reopened.availableKg).toBe('250.000');
    const stillLive = await movements(api, coil.id);
    expect(stillLive.find((m) => m.id === adjustment.id)?.reversedById).toBeNull();
    // Y sigue inerte para siempre: el kardex es append-only, así que ese ajuste nunca vuelve
    // a ser el último movimiento vivo.
    await closeCoilKeepingStock(api, coil.id, 'Se vuelve a cerrar sin liquidar (prueba E2E)');
    const reopenedAgain = await postJson<CoilDto>(api, `/api/coils/${coil.id}/status`, {
      status: 'OPEN',
      reason: 'Y se vuelve a abrir (prueba E2E)',
    });
    expect(reopenedAgain.availableKg).toBe('250.000');
  });

  test('el schema rechaza los kilos imposibles antes de tocar el kardex', async () => {
    const { coil } = await buyCoil(api, { supplier, finish, weightKg: '150', unitPrice: '4' });

    const negativo = await closeExpectingError(api, coil.id, {
      status: 'CLOSED',
      physicalKg: '-5',
      reason: 'Motivo cualquiera (prueba E2E)',
    });
    expect(negativo.status).toBe(400);
    expect(negativo.message).toContain('negativos');

    // Declarar kilos al **abrir** no significa nada: el schema lo corta para que no parezca
    // que reabrir también admite un conteo.
    const alAbrir = await closeExpectingError(api, coil.id, { status: 'OPEN', physicalKg: '10' });
    expect(alAbrir.status).toBe(400);
    expect(alAbrir.message).toContain('al cerrar');

    // Y un rollo no puede tener más material del que ingresó: es la cota que impide que un
    // `1500` tipeado donde iba `150` dé de alta 1 350 kg valorizados, con un texto libre como
    // única justificación.
    const imposible = await closeExpectingError(api, coil.id, {
      status: 'CLOSED',
      physicalKg: '1500',
      reason: 'Conteo imposible (prueba E2E)',
    });
    expect(imposible.status).toBe(400);
    expect(imposible.message).toContain('ingresó');

    const intacta = await getJson<CoilDto>(api, `/api/coils/${coil.id}`);
    expect(intacta.status).toBe('OPEN');
    expect(intacta.availableKg).toBe('150.000');
    expect(await movements(api, coil.id)).toHaveLength(1);
  });
});
