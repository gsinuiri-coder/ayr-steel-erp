import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import {
  createFinish,
  getItems,
  getJson,
  postJson,
  type CreatedFinish,
  type CreatedSupplier,
  type CreatedUser,
} from './api';

/**
 * Utilidades compartidas por los specs de Fase 4 (producción de drywall,
 * RF-32..35 / D-055..D-060). Viven acá y no dentro de un spec para que
 * `fase4.spec.ts` (flujos principales) y `fase4-bordes.spec.ts` (bordes y reversas)
 * armen exactamente el mismo escenario y limpien de la misma forma.
 */

export const LINE = 'drywall';
/** Receta de las pruebas: 2 kg de fleje por pieza. Deja la aritmética a ojo desnudo. */
export const KG_PER_PIECE = '2.000';
/** Contraseña definitiva de los usuarios de prueba por rol (RF-01 obliga a cambiarla). */
export const ROLE_PASSWORD = 'ClaveRolE2E-2026';

// ---------------------------------------------------------------------------
// DTOs mínimos del API que consumen los tests
// ---------------------------------------------------------------------------

export interface PurchaseDto {
  id: string;
  status: string;
}

export interface CoilDto {
  id: string;
  code: string;
  kind: string;
  /** D-085: color de la bobina; null en las galvanizadas. */
  colorId?: string | null;
  purchaseId?: string | null;
  typeKey: string;
  status: string;
  widthMm: string;
  availableKg: string;
  parentCoilId: string | null;
  /** D-124: día de negocio en que la bobina entró (`AAAA-MM-DD`, Lima). */
  operationDate?: string;
}

export interface CuttingOrderDto {
  id: string;
  status: string;
  coils: { coilId: string; status: string; strips: { id: string; code: string }[] }[];
}

export interface BusinessLineDto {
  id: string;
  code: string;
}

export interface ProductDto {
  id: string;
  sku: string;
  businessLineId: string;
  unit: string;
  colorId?: string | null;
  /** D-122: acabado del SKU (obligatorio en Metallic Roofing); de él sale la densidad. */
  finishId?: string | null;
  finishCode?: string | null;
  finishName?: string | null;
  densityFactor?: string | null;
  /** D-118 (Fase 7e): campos estructurados del SKU. Null salvo en la línea que los exige. */
  thicknessMm?: string | null;
  widthMm?: string | null;
  lengthMm?: string | null;
  pieceWeightKg?: string | null;
  theoreticalKgPerUnit?: string | null;
}

export interface ProductBomDto {
  id: string;
  productId: string;
  /** D-122: desde entonces, solo `DRYWALL` — una cobertura ya no lleva receta. */
  kind: string;
  /** D-139: sale de `products.pieceWeightKg`, no de la geometría del fleje. */
  kgPerPiece: string | null;
  inputWidthMm: string | null;
  /** D-139: sale de `products.lengthMm`. */
  pieceLengthMm: string | null;
  inputThicknessMm: string;
}

export interface ProductionConsumptionDto {
  id: string;
  coilId: string;
  coilCode: string;
  assignedKg: string;
  consumedKg: string;
  remainingKg: string;
  parentCoilId: string | null;
  parentCoilCode: string | null;
  releasedAt: string | null;
}

export interface ProductionReportDto {
  id: string;
  pieces: number;
  /** D-083: metros que entraron al kardex. Null en drywall y en plancha de catálogo. */
  metersM?: string | null;
  piecesDetail?: { lineNumber: number; lengthMm: string; qty: number }[];
  theoreticalKg: string;
  materialCostPen: string | null;
  unitCostPen: string | null;
  status: string;
  revertedAt: string | null;
}

export interface ProductionOrderDto {
  id: string;
  code: string;
  /** D-087: `DRYWALL` o `ROOFING`. */
  kind: string;
  status: string;
  productId: string;
  productUnit: string;
  /** D-084: el pedido del que nació. Null en una corrida de stock de drywall. */
  salesOrderId: string | null;
  salesOrderCode: string | null;
  customerName: string | null;
  /** D-084: el plan de corte copiado del pedido. Vacío en drywall. */
  items: { lineNumber: number; lengthMm: string; qty: number }[];
  piecesReported: number;
  /** D-083: metros buenos acumulados. Null cuando el producto se cuenta en piezas. */
  metersReported: string | null;
  /** D-089: los kilos que planta declaró que la bobina consumió. */
  consumedDeclaredKg: string | null;
  assignedKg: string;
  consumedKg: string;
  scrapKg: string | null;
  materialCostPen: string | null;
  overheadCostPen: string | null;
  totalCostPen: string | null;
  unitCostPen: string | null;
  consumptions: ProductionConsumptionDto[];
  reports: ProductionReportDto[];
}

export interface StripOptionDto {
  coilId: string;
  code: string;
  availableKg: string;
  estimatedPieces: number;
}

export interface BalanceDto {
  itemId: string;
  qty: string;
  avgCost: string | null;
  unit: string;
}

export interface MovementDto {
  id: string;
  type: string;
  qty: string;
  totalCost: string | null;
  refType: string;
  refId: string | null;
  notes: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  /** Instante de grabación (auditoría). D-124: **no** es la fecha por la que el kardex ordena. */
  at?: string;
  /** D-124: día de negocio del movimiento (`AAAA-MM-DD`, Lima). Por acá ordena y corta el kardex. */
  operationDate?: string;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

export function uniqueDocumentNumber(): string {
  return String(Date.now()).slice(-9);
}

/**
 * El día de hoy **en Lima**, no en UTC.
 *
 * Es la misma lección de D-069, que el API ya había aprendido con `businessToday`: Lima va
 * cinco horas detrás, así que entre las 19:00 y la medianoche `toISOString()` devuelve la
 * fecha de mañana. Con eso, cualquier documento que el test fechara "hoy" se rechazaba por
 * futuro durante las últimas cinco horas del día — un fallo que aparece según la hora a la
 * que corras la suite y no se parece en nada a su causa.
 */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function randomLetters(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export async function createCuttingSupplier(api: APIRequestContext): Promise<CreatedSupplier> {
  const code = `EP${randomLetters(4)}`;
  return postJson<CreatedSupplier>(api, '/api/suppliers', {
    code,
    docType: 'RUC',
    docNumber: `20${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
    name: `E2E Proveedor de corte ${code}`,
    creditDays: 0,
    providesCuttingService: true,
  });
}

export interface ApiError {
  status: number;
  message: string;
}

export async function errorFrom(res: APIResponse, label: string): Promise<ApiError> {
  expect(res.ok(), `${label} debía fallar y devolvió ${res.status()}`).toBe(false);
  const body = (await res.json()) as { message?: string | string[] };
  const message = Array.isArray(body.message) ? body.message.join(', ') : (body.message ?? '');
  return { status: res.status(), message };
}

export async function postExpectingError(
  api: APIRequestContext,
  path: string,
  data?: unknown,
): Promise<ApiError> {
  const res = await api.post(path, data === undefined ? undefined : { data });
  return errorFrom(res, `POST ${path}`);
}

export async function getExpectingError(api: APIRequestContext, path: string): Promise<ApiError> {
  const res = await api.get(path);
  return errorFrom(res, `GET ${path}`);
}

export async function putExpectingError(
  api: APIRequestContext,
  path: string,
  data: unknown,
): Promise<ApiError> {
  const res = await api.put(path, { data });
  return errorFrom(res, `PUT ${path}`);
}

/** La receta se guarda con PUT (alta y edición son la misma operación, D-059). */
export async function putJson<T>(api: APIRequestContext, path: string, data: unknown): Promise<T> {
  const res = await api.put(path, { data });
  if (!res.ok()) throw new Error(`PUT ${path} falló: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function balanceOf(
  api: APIRequestContext,
  itemType: 'COIL' | 'PRODUCT',
  itemId: string,
): Promise<BalanceDto> {
  const balance = await optionalBalanceOf(api, itemType, itemId);
  expect(balance, `${itemType} ${itemId} no tiene saldo de kardex`).not.toBeNull();
  return balance!;
}

/** Saldo del ítem, o `null` si nunca tuvo un movimiento (todavía no existe la fila). */
export async function optionalBalanceOf(
  api: APIRequestContext,
  itemType: 'COIL' | 'PRODUCT',
  itemId: string,
): Promise<BalanceDto | null> {
  const balances = await getJson<BalanceDto[]>(
    api,
    `/api/inventory/balances?itemType=${itemType}&itemId=${itemId}`,
  );
  return balances[0] ?? null;
}

/** Kardex del ítem en orden cronológico (el API lo devuelve del más reciente al más viejo). */
export async function movementsOf(
  api: APIRequestContext,
  itemType: 'COIL' | 'PRODUCT',
  itemId: string,
): Promise<MovementDto[]> {
  const movements = await getItems<MovementDto>(
    api,
    `/api/inventory/movements?itemType=${itemType}&itemId=${itemId}`,
  );
  return [...movements].sort((a, b) => Number(a.id) - Number(b.id));
}

/** Movimientos que siguen afectando el saldo (ni son reversa ni fueron revertidos). */
export function live(movements: MovementDto[]): MovementDto[] {
  return movements.filter((m) => m.reversalOfId === null && m.reversedById === null);
}

/**
 * Contexto de API autenticado como un usuario recién creado (copiado de `fase3.spec.ts`).
 * El primer ingreso obliga a cambiar la contraseña temporal (RF-01) antes de dejar pasar
 * cualquier otra operación.
 */
export async function apiAs(baseURL: string, user: CreatedUser): Promise<APIRequestContext> {
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

// ---------------------------------------------------------------------------
// Maestro: producto de catálogo y receta
// ---------------------------------------------------------------------------

export async function businessLineId(api: APIRequestContext, code: string): Promise<string> {
  const lines = await getJson<BusinessLineDto[]>(api, '/api/business-lines');
  const line = lines.find((l) => l.code === code);
  expect(line, `No existe la línea de negocio ${code}`).toBeDefined();
  return line!.id;
}

/**
 * Producto de catálogo de prueba. Por defecto el perfil que Fase 4 sabe producir:
 * drywall, fabricado y medido en piezas (D-055). Los overrides sirven para los casos
 * que la receta debe rechazar.
 */
export async function createCatalogProduct(
  api: APIRequestContext,
  options: {
    lineCode?: string;
    unit?: string;
    source?: 'MANUFACTURED' | 'PURCHASED';
    name?: string;
    /** D-118: campos estructurados de la pieza terminada; con overrides propios si hacen falta. */
    widthMm?: string;
    lengthMm?: string;
    /**
     * D-139: kilos que consume cada pieza terminada (drywall). El default `'6'` sirve para
     * cualquier test al que no le importe el número; `''` (cadena vacía) lo deja `null` a
     * propósito — es lo que exige el caso "sin peso por pieza no hay receta" (D-139).
     */
    pieceWeightKg?: string;
    thicknessMm?: string;
    /** D-122: acabado del SKU. Obligatorio en Metallic Roofing; de él sale la densidad. */
    finishId?: string;
    /** D-127: subtipo de cobertura. Sin él se deduce de la unidad (ver `roofingKindFor`). */
    roofingKind?: 'PLANCHA' | 'A_MEDIDA';
  } = {},
): Promise<ProductDto> {
  const lineCode = options.lineCode ?? LINE;
  const lineId = await businessLineId(api, lineCode);
  const unit = options.unit ?? 'NIU';
  // D-118 (Fase 7e): Drywall exige ancho/largo/peso de la pieza terminada y Metallic
  // Roofing exige espesor/ancho/acabado del SKU (D-122). Sin esto `POST /catalog` rechaza
  // el alta con "El ancho de la pieza terminada es obligatorio en Drywall" (u homólogo). El
  // resto de líneas no los usa, así que no se manda nada si `lineCode` no es una de las dos.
  const structured =
    lineCode === LINE
      ? {
          widthMm: options.widthMm ?? '100',
          lengthMm: options.lengthMm ?? '3000',
          pieceWeightKg: options.pieceWeightKg ?? '6',
        }
      : lineCode === 'metallic-roofing'
        ? {
            thicknessMm: options.thicknessMm ?? '0.50',
            widthMm: options.widthMm ?? '1000',
            ...(options.finishId === undefined ? {} : { finishId: options.finishId }),
            ...roofingKindFields(unit, options.roofingKind, options.lengthMm),
          }
        : {};
  return postJson<ProductDto>(api, '/api/catalog', {
    businessLineId: lineId,
    // Prefijo con separador, igual que los proveedores `E2E …`: es la marca con la que
    // `pnpm prod:purge-e2e` reconoce lo que puede deshacer en producción.
    sku: `E2E-PERF${randomLetters(5)}`,
    name: options.name ?? 'Perfil E2E de drywall',
    unit,
    source: options.source ?? 'MANUFACTURED',
    ...structured,
  });
}

/**
 * D-127: los campos de subtipo con los que un SKU de Metallic Roofing entra al catálogo.
 *
 * Desde D-127 el subtipo es **obligatorio y explícito** en esa línea, y arrastra dos reglas
 * más: `A_MEDIDA` se mide en `MTR` y no lleva largo; `PLANCHA` se mide en otra unidad y el
 * largo es obligatorio. Los helpers de la suite lo deducen de la unidad —que es lo que ya
 * decían— para que ningún spec anterior tenga que enterarse, y quien necesite el caso raro
 * (una plancha en `MTR`, que el API debe rechazar) lo pasa a mano.
 */
export function roofingKindFields(
  unit: string,
  roofingKind?: 'PLANCHA' | 'A_MEDIDA',
  lengthMm?: string,
): Record<string, unknown> {
  const kind = roofingKind ?? (unit === 'MTR' ? 'A_MEDIDA' : 'PLANCHA');
  if (kind === 'A_MEDIDA') return { roofingKind: kind };
  return { roofingKind: kind, lengthMm: lengthMm ?? '3000' };
}

/**
 * Receta de drywall (D-059). Desde D-122/D-139 solo describe el fleje de entrada (acabado,
 * espesor, ancho): el largo de la pieza y sus kilos ya no viven acá, viven en el propio SKU
 * (`products.lengthMm`/`products.pieceWeightKg`, D-118/D-139) y `kgPerPiece` en el DTO los
 * lee de ahí. El producto **necesita `pieceWeightKg` cargado antes** de poder tener receta,
 * o el API lo rechaza (D-139).
 */
export async function upsertBom(
  api: APIRequestContext,
  productId: string,
  input: {
    finishId: string;
    inputThicknessMm?: string;
    inputWidthMm?: string;
  },
): Promise<ProductBomDto> {
  return putJson<ProductBomDto>(api, `/api/production/boms/${productId}`, {
    finishId: input.finishId,
    inputThicknessMm: input.inputThicknessMm ?? '0.50',
    inputWidthMm: input.inputWidthMm ?? '600',
  });
}

// ---------------------------------------------------------------------------
// Escenario completo: bobina → corte tercerizado → flejes → producto con receta
// ---------------------------------------------------------------------------

export interface Scenario {
  supplier: CreatedSupplier;
  finish: CreatedFinish;
  purchaseId: string;
  mother: CoilDto;
  cuttingOrderId: string;
  strips: CoilDto[];
  product: ProductDto;
  bom: ProductBomDto;
}

/**
 * Deja el escenario listo: bobina madre comprada y recibida (4 800 kg a S/ 4/kg, 1 200 mm),
 * partida por un tercero en dos flejes de 600 mm × 2 400 kg (RF-40/41), y un perfil de
 * drywall con su receta (D-059) de 2 kg por pieza.
 */
export async function setupScenario(
  api: APIRequestContext,
  options: { stripCount?: number } = {},
): Promise<Scenario> {
  const supplier = await createCuttingSupplier(api);
  const finish = await createFinish(api);

  const purchase = await postJson<PurchaseDto>(api, '/api/purchases', {
    supplierId: supplier.id,
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
        description: 'Bobina E2E Fase 4 para perfilar drywall',
        qty: '4800',
        unit: 'KGM',
        unitPrice: '4',
        finishId: finish.id,
        widthMm: '1200',
        thicknessMm: '0.50',
        // D-117 (Fase 7e): una bobina nueva nace CLOSED por defecto; este escenario la
        // manda de inmediato a corte tercerizado, que exige OPEN.
        coilStatus: 'OPEN',
      },
    ],
  });
  await postJson<PurchaseDto>(api, `/api/purchases/${purchase.id}/receive`);
  const coils = await getItems<CoilDto>(api, `/api/coils?supplierId=${supplier.id}`);
  const mother = coils[0]!;

  // Corte tercerizado: es la única vía que produce flejes (`kind=STRIP`, D-049), que es
  // lo que la perfiladora de drywall consume.
  const order = await postJson<CuttingOrderDto>(api, '/api/cutting', {
    supplierId: supplier.id,
    notes: 'Corte E2E Fase 4 para producir perfiles',
    coils: [
      {
        coilId: mother.id,
        widthPlanMm: [{ widthMm: '600', stripsCount: 2 }],
        expectedKerfLossMm: '0',
      },
    ],
  });
  const received = await postJson<CuttingOrderDto>(
    api,
    `/api/cutting/${order.id}/coils/${mother.id}/receive`,
    {
      receivedWidthsMm: [{ widthMm: '600', stripsCount: 2 }],
      receivedWeightKg: '4800',
      kerfLossMm: '0',
    },
  );
  const stripRefs = received.coils.find((c) => c.coilId === mother.id)!.strips;
  expect(stripRefs).toHaveLength(2);
  const strips: CoilDto[] = [];
  for (const ref of stripRefs.slice(0, options.stripCount ?? 2)) {
    strips.push(await getJson<CoilDto>(api, `/api/coils/${ref.id}`));
  }
  expect(strips[0]).toMatchObject({ kind: 'STRIP', widthMm: '600.00', availableKg: '2400.000' });

  // Producto terminado: piezas (NIU), fabricado, línea drywall (D-055). D-139: los kilos
  // por pieza se cargan en el propio SKU, no en la receta.
  const product = await createCatalogProduct(api, { pieceWeightKg: KG_PER_PIECE });
  const bom = await upsertBom(api, product.id, { finishId: finish.id });
  expect(bom.kgPerPiece).toBe(KG_PER_PIECE);

  return {
    supplier,
    finish,
    purchaseId: purchase.id,
    mother,
    cuttingOrderId: order.id,
    strips,
    product,
    bom,
  };
}

// ---------------------------------------------------------------------------
// Limpieza
// ---------------------------------------------------------------------------

/**
 * Deja la OP en `CANCELLED` y su kardex en cero: reabre si está cerrada (D-060), revierte
 * los reportes vigentes del último al primero y anula. Es el mismo camino que
 * `pnpm prod:purge-e2e`, y por eso los tests lo corren también en local: si una corrida
 * no se puede deshacer, la prueba lo dice acá y no en producción.
 */
export async function purgeProductionOrder(api: APIRequestContext, orderId: string): Promise<void> {
  const order = await getJson<ProductionOrderDto>(api, `/api/production/${orderId}`);
  if (order.status === 'CANCELLED') return;
  if (order.status === 'CLOSED') {
    await postJson<ProductionOrderDto>(api, `/api/production/${orderId}/reopen`, {
      reason: 'Limpieza de la prueba E2E',
    });
  }
  const current = await getJson<ProductionOrderDto>(api, `/api/production/${orderId}`);
  const active = current.reports.filter((r) => r.status === 'ACTIVE');
  for (const report of [...active].reverse()) {
    await postJson<ProductionOrderDto>(
      api,
      `/api/production/${orderId}/reports/${report.id}/reverse`,
      { reason: 'Limpieza de la prueba E2E' },
    );
  }
  await postJson<ProductionOrderDto>(api, `/api/production/${orderId}/cancel`, {
    reason: 'Limpieza de la prueba E2E',
  });
}

/**
 * Deja inerte en producción lo que el test creó. Nunca lanza: es limpieza de `finally`.
 * El orden importa: primero las OP (liberan los flejes), después la reversa de la
 * recepción de corte y la cancelación del envío, y recién ahí las anulaciones.
 *
 * `productionOrderIds` va en **orden de creación**: las OP se purgan de la última a la
 * primera, porque el ajuste de costo del cierre de la última bloquea la reversa de los
 * reportes de las anteriores (D-056).
 */
export async function deactivateTrail(
  api: APIRequestContext,
  trail: {
    productionOrderIds?: string[];
    cuttingOrderId?: string;
    motherId?: string;
    purchaseId?: string;
    supplierId?: string;
    finish?: CreatedFinish;
    productId?: string;
    productIds?: string[];
    customerIds?: string[];
  },
): Promise<void> {
  for (const orderId of [...(trail.productionOrderIds ?? [])].reverse()) {
    await purgeProductionOrder(api, orderId).catch(() => undefined);
  }
  if (trail.cuttingOrderId && trail.motherId) {
    await api
      .post(`/api/cutting/${trail.cuttingOrderId}/coils/${trail.motherId}/reverse`, {
        data: { reason: 'Limpieza de prueba E2E' },
      })
      .catch(() => undefined);
    await api
      .post(`/api/cutting/${trail.cuttingOrderId}/cancel`, {
        data: { reason: 'Limpieza de prueba E2E' },
      })
      .catch(() => undefined);
  }
  if (trail.motherId) {
    await api
      .post(`/api/coils/${trail.motherId}/cancel`, { data: { reason: 'Limpieza de prueba E2E' } })
      .catch(() => undefined);
  }
  if (trail.purchaseId) {
    await api
      .post(`/api/purchases/${trail.purchaseId}/cancel`, {
        data: { reason: 'Limpieza de prueba E2E' },
      })
      .catch(() => undefined);
  }
  for (const productId of [...(trail.productIds ?? []), trail.productId].filter(Boolean)) {
    await api
      .patch(`/api/catalog/${productId}`, { data: { isActive: false } })
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
  }
  for (const customerId of trail.customerIds ?? []) {
    await api
      .patch(`/api/customers/${customerId}`, { data: { isActive: false } })
      .catch(() => undefined);
  }
}
