import {
  BUSINESS_LINE_LABELS,
  cashSessionCode,
  dispatchCode,
  posSaleCode,
  productionOrderCode,
  quotationCode,
  salesOrderCode,
  type AuditEntityType,
} from '@ayr/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { fromDbLineCode } from '../common/business-line-code';

/**
 * cc48 (D-633): el código legible de cada fila de la auditoría, resuelto **al leer**, sin
 * columnas nuevas: `audit_log` guarda el tipo y el id de la entidad, y aquí se buscan sus
 * códigos **por lotes**, una consulta por tipo de entidad presente en la página (nunca una por
 * fila). Si la entidad ya no existe se usa el código que el registro guardó en su detalle, o
 * «Eliminado · <8 primeros del id>».
 */

export interface EntityRef {
  code: string;
  /** Su página de detalle, si existe. */
  href: string | null;
}

/** Lo que resuelve un tipo: sus ids (ya validados) → su código y su enlace. */
type Resolver = (prisma: PrismaService, ids: string[]) => Promise<Map<string, EntityRef>>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ref = (code: string, href: string | null = null): EntityRef => ({ code, href });

function byId<T extends { id: string }>(
  rows: T[],
  toRef: (row: T) => EntityRef,
): Map<string, EntityRef> {
  return new Map(rows.map((r) => [r.id, toRef(r)]));
}

const lineLabel = (code: string): string => {
  try {
    return BUSINESS_LINE_LABELS[fromDbLineCode(code)];
  } catch {
    return code;
  }
};

/** El enlace a un cliente: su búsqueda en la lista (D-172), como el resto del sistema. */
const customerHref = (docNumber: string) => `/clientes?search=${encodeURIComponent(docNumber)}`;

const RESOLVERS: Record<AuditEntityType, Resolver | { fixed: string; href?: string }> = {
  cash_sessions: async (p, ids) =>
    byId(
      await p.cashSession.findMany({ where: { id: { in: ids } }, select: { id: true, seq: true } }),
      (r) => ref(cashSessionCode(r.seq)),
    ),
  coil_splits: async (p, ids) =>
    byId(
      await p.coilSplit.findMany({
        where: { id: { in: ids } },
        select: { id: true, parentCoilId: true, parentCoil: { select: { code: true } } },
      }),
      (r) => ref(`Partido de ${r.parentCoil.code}`, `/bobinas/${r.parentCoilId}`),
    ),
  coils: async (p, ids) =>
    byId(
      await p.coil.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } }),
      (r) => ref(r.code, `/bobinas/${r.id}`),
    ),
  colors: async (p, ids) =>
    byId(
      await p.color.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
      (r) => ref(r.name),
    ),
  customer_payments: async (p, ids) =>
    byId(
      await p.customerPayment.findMany({
        where: { id: { in: ids } },
        select: { id: true, documentId: true, document: { select: { number: true } } },
      }),
      (r) => ref(`Cobro de ${r.document.number ?? 'borrador'}`, `/comprobantes/${r.documentId}`),
    ),
  customers: async (p, ids) =>
    byId(
      await p.customer.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, docNumber: true },
      }),
      (r) => ref(r.name, customerHref(r.docNumber)),
    ),
  cutting_orders: async (p, ids) =>
    byId(
      await p.cuttingOrder.findMany({
        where: { id: { in: ids } },
        select: { id: true, operationDate: true, supplier: { select: { name: true } } },
      }),
      (r) =>
        ref(
          `Corte · ${r.supplier.name} · ${r.operationDate.toISOString().slice(0, 10)}`,
          `/corte/${r.id}`,
        ),
    ),
  dispatches: async (p, ids) =>
    byId(
      await p.dispatch.findMany({ where: { id: { in: ids } }, select: { id: true, seq: true } }),
      (r) => ref(dispatchCode(r.seq), `/despachos/${r.id}`),
    ),
  exchange_rates: async (p, ids) =>
    byId(
      await p.exchangeRate.findMany({
        where: { id: { in: ids } },
        select: { id: true, date: true },
      }),
      (r) => ref(`TC ${r.date.toISOString().slice(0, 10)}`, '/configuracion/tipo-cambio'),
    ),
  finishes: async (p, ids) =>
    byId(
      await p.finish.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } }),
      (r) => ref(r.code),
    ),
  fiscal_documents: async (p, ids) =>
    byId(
      await p.fiscalDocument.findMany({
        where: { id: { in: ids } },
        select: { id: true, number: true },
      }),
      (r) => ref(r.number ?? 'Borrador', `/comprobantes/${r.id}`),
    ),
  fiscal_series: async (p, ids) =>
    byId(
      await p.fiscalSeries.findMany({
        where: { id: { in: ids } },
        select: { id: true, series: true },
      }),
      (r) => ref(`Serie ${r.series}`),
    ),
  invoicing_settings: { fixed: 'Configuración de facturación' },
  pos_sales: async (p, ids) =>
    byId(
      await p.posSale.findMany({
        where: { id: { in: ids } },
        select: { id: true, seq: true, fiscalDocumentId: true },
      }),
      (r) => ref(posSaleCode(r.seq), `/comprobantes/${r.fiscalDocumentId}`),
    ),
  pricing_settings: async (p, ids) =>
    byId(
      await p.pricingSetting.findMany({
        where: { id: { in: ids } },
        select: { id: true, businessLine: { select: { code: true } } },
      }),
      (r) => ref(`Márgenes · ${lineLabel(r.businessLine.code)}`, '/configuracion/margenes'),
    ),
  product_boms: async (p, ids) =>
    byId(
      await p.productBom.findMany({
        where: { id: { in: ids } },
        select: { id: true, product: { select: { sku: true } } },
      }),
      (r) => ref(`Receta de ${r.product.sku}`),
    ),
  production_orders: async (p, ids) =>
    byId(
      await p.productionOrder.findMany({
        where: { id: { in: ids } },
        select: { id: true, seq: true },
      }),
      (r) => ref(productionOrderCode(r.seq), `/produccion/${r.id}`),
    ),
  products: async (p, ids) =>
    byId(
      await p.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true } }),
      (r) => ref(r.sku),
    ),
  // cc50 (D-638): un lote no tiene tabla ni se borra; su código es el mismo que muestra el
  // importador (los 8 primeros del id), sin consulta.
  purchase_import_batches: (_p, ids) =>
    Promise.resolve(new Map(ids.map((id) => [id, ref(`Lote ${id.slice(0, 8)}`)]))),
  purchases: async (p, ids) =>
    byId(
      await p.purchase.findMany({
        where: { id: { in: ids } },
        select: { id: true, series: true, number: true },
      }),
      (r) => ref(`${r.series}-${r.number}`, `/compras/${r.id}`),
    ),
  quotations: async (p, ids) =>
    byId(
      await p.quotation.findMany({ where: { id: { in: ids } }, select: { id: true, seq: true } }),
      (r) => ref(quotationCode(r.seq), `/cotizaciones/${r.id}`),
    ),
  reservations: async (p, ids) =>
    byId(
      await p.reservation.findMany({
        where: { id: { in: ids } },
        select: { id: true, salesOrderId: true, salesOrder: { select: { seq: true } } },
      }),
      (r) => ref(`Reserva de ${salesOrderCode(r.salesOrder.seq)}`, `/pedidos/${r.salesOrderId}`),
    ),
  sales_orders: async (p, ids) =>
    byId(
      await p.salesOrder.findMany({ where: { id: { in: ids } }, select: { id: true, seq: true } }),
      (r) => ref(salesOrderCode(r.seq), `/pedidos/${r.id}`),
    ),
  sales_settings: { fixed: 'Configuración de ventas', href: '/configuracion/reservas' },
  sessions: async (p, ids) =>
    byId(
      await p.session.findMany({
        where: { id: { in: ids } },
        select: { id: true, user: { select: { name: true } } },
      }),
      (r) => ref(`Sesión de ${r.user.name}`),
    ),
  suppliers: async (p, ids) =>
    byId(
      await p.supplier.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
      (r) => ref(r.name),
    ),
  users: async (p, ids) =>
    byId(
      await p.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
      (r) => ref(r.name),
    ),
};

/** Si el visor sabe resolver este tipo (propio del mapa, nunca del prototipo de `Object`). */
function isKnownType(entityType: string): entityType is AuditEntityType {
  return Object.hasOwn(RESOLVERS, entityType);
}

/** La clave de una entidad en el mapa de resultados. */
export const refKey = (entityType: string, entityId: string) => `${entityType}:${entityId}`;

/**
 * Los códigos de las entidades de una página, por lotes: una consulta por tipo presente (los tipos
 * fijos, como la configuración, no consultan). Un id que no tiene forma de UUID no llega a la base.
 */
export async function resolveEntityRefs(
  prisma: PrismaService,
  rows: readonly { entityType: string; entityId: string | null }[],
): Promise<Map<string, EntityRef>> {
  const idsByType = new Map<AuditEntityType, Set<string>>();
  for (const r of rows) {
    if (r.entityId === null || !isKnownType(r.entityType)) continue;
    const type = r.entityType;
    const set = idsByType.get(type) ?? new Set<string>();
    set.add(r.entityId);
    idsByType.set(type, set);
  }
  const out = new Map<string, EntityRef>();
  await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => {
      const resolver = RESOLVERS[type];
      if (typeof resolver !== 'function') {
        for (const id of ids) out.set(refKey(type, id), ref(resolver.fixed, resolver.href ?? null));
        return;
      }
      const valid = [...ids].filter((id) => UUID_RE.test(id));
      if (valid.length === 0) return;
      for (const [id, r] of await resolver(prisma, valid)) out.set(refKey(type, id), r);
    }),
  );
  return out;
}

/** Los campos del detalle donde un registro suele guardar el código o el nombre de su entidad. */
const STORED_CODE_KEYS = ['code', 'number', 'sku', 'name', 'series', 'docNumber'] as const;

/** El código que el registro guardó en su detalle (`after` primero), si guardó alguno. */
export function storedCode(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string | null {
  for (const detail of [after, before]) {
    if (detail === null) continue;
    for (const key of STORED_CODE_KEYS) {
      const v = detail[key];
      if (typeof v === 'string' && v.trim() !== '') return v.trim();
    }
  }
  return null;
}

/** Lo que muestra la fila: el código vivo, el guardado o «Eliminado · <8 del id>». */
export function entityDisplay(
  event: {
    entityType: string;
    entityId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
  refs: Map<string, EntityRef>,
): { entityCode: string | null; entityHref: string | null; entityDeleted: boolean } {
  if (event.entityId === null) return { entityCode: null, entityHref: null, entityDeleted: false };
  // Un tipo que el visor no conoce no se puede resolver: se muestra su id tal cual, sin decir
  // que se borró.
  if (!isKnownType(event.entityType)) {
    return { entityCode: event.entityId, entityHref: null, entityDeleted: false };
  }
  const live = refs.get(refKey(event.entityType, event.entityId));
  if (live) return { entityCode: live.code, entityHref: live.href, entityDeleted: false };
  const stored = storedCode(event.before, event.after);
  return {
    entityCode: stored ?? `Eliminado · ${event.entityId.slice(0, 8)}`,
    entityHref: null,
    entityDeleted: true,
  };
}

/** Cuántos ids trae como mucho cada tipo al buscar: el buscar acota, no es un listado. */
export const SEARCH_IDS_PER_TYPE = 200;

/** `PED-000031`, `ped31`, `OP-12`: el prefijo de un correlativo y su número. */
const SEQ_CODE_RE = /^(COT|PED|OP|DES|CAJA|MOS)-?0*(\d{1,9})$/i;

const SEQ_TYPES: Record<string, AuditEntityType> = {
  COT: 'quotations',
  PED: 'sales_orders',
  OP: 'production_orders',
  DES: 'dispatches',
  CAJA: 'cash_sessions',
  MOS: 'pos_sales',
};

/** El buscar resuelto a ids: los que coinciden por tipo y si algún tipo llegó al tope. */
export interface SearchRefs {
  refs: Map<AuditEntityType, string[]>;
  /** Algún tipo tenía más de `SEARCH_IDS_PER_TYPE` coincidencias: la pantalla pide acotar. */
  capped: boolean;
}

/**
 * cc48 (D-634): el buscar del visor por código legible. La auditoría guarda solo el id, así que el
 * texto se resuelve primero a ids por tipo (una consulta por tipo, con tope y en orden fijo, para
 * que todas las páginas usen los mismos) y la página filtra por esos ids. Un correlativo
 * (`PED-000031`) va directo a su tipo; cualquier otro texto busca «contiene» en los códigos y
 * nombres que la fila muestra. Un tipo sin coincidencias no entra al mapa.
 */
export async function searchEntityIds(prisma: PrismaService, search: string): Promise<SearchRefs> {
  const refs = new Map<AuditEntityType, string[]>();
  let capped = false;
  const add = (t: AuditEntityType, rows: { id: string }[]) => {
    if (rows.length > SEARCH_IDS_PER_TYPE) capped = true;
    if (rows.length > 0)
      refs.set(
        t,
        rows.slice(0, SEARCH_IDS_PER_TYPE).map((r) => r.id),
      );
  };
  const seq = SEQ_CODE_RE.exec(search.trim());
  if (seq) {
    const [, prefix = '', digits = ''] = seq;
    const key = prefix.toUpperCase();
    const where = { seq: Number(digits) };
    const select = { id: true } as const;
    const found: Record<string, () => Promise<{ id: string }[]>> = {
      COT: () => prisma.quotation.findMany({ where, select }),
      PED: () => prisma.salesOrder.findMany({ where, select }),
      OP: () => prisma.productionOrder.findMany({ where, select }),
      DES: () => prisma.dispatch.findMany({ where, select }),
      CAJA: () => prisma.cashSession.findMany({ where, select }),
      MOS: () => prisma.posSale.findMany({ where, select }),
    };
    const fetch = found[key];
    const t = SEQ_TYPES[key];
    if (fetch && t) add(t, await fetch());
    return { refs, capped };
  }
  const text = { contains: search.trim(), mode: 'insensitive' as const };
  const page = {
    select: { id: true } as const,
    orderBy: { id: 'asc' as const },
    take: SEARCH_IDS_PER_TYPE + 1,
  };
  const [coils, products, customers, suppliers, documents, purchases, users] = await Promise.all([
    prisma.coil.findMany({ where: { code: text }, ...page }),
    prisma.product.findMany({ where: { OR: [{ sku: text }, { name: text }] }, ...page }),
    prisma.customer.findMany({ where: { OR: [{ name: text }, { docNumber: text }] }, ...page }),
    prisma.supplier.findMany({ where: { OR: [{ name: text }, { docNumber: text }] }, ...page }),
    prisma.fiscalDocument.findMany({ where: { number: text }, ...page }),
    prisma.purchase.findMany({ where: { OR: [{ number: text }, { series: text }] }, ...page }),
    prisma.user.findMany({ where: { name: text }, ...page }),
  ]);
  add('coils', coils);
  add('products', products);
  add('customers', customers);
  add('suppliers', suppliers);
  add('fiscal_documents', documents);
  add('purchases', purchases);
  add('users', users);
  return { refs, capped };
}
