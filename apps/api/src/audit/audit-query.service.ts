import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  addDays,
  businessToday,
  AUDIT_DEFAULT_RANGE_DAYS,
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_MAX_RANGE_MONTHS,
  AUDIT_SOURCES,
  auditTextSearchApplies,
  type AuditEntityType,
  type AuditEventDto,
  type AuditExportQuery,
  type AuditPageDto,
  type AuditQuery,
  type AuditSource,
} from '@ayr/shared';
import { assertExportable, exportWindow } from '../common/list-export';
import { PrismaService } from '../prisma/prisma.service';
import {
  afterCursorWhere,
  decodeCursor,
  encodeCursor,
  sourceRank,
  type AuditCursor,
  type CursorBoundary,
} from './audit-cursor';
import {
  entityDisplay,
  resolveEntityRefs,
  searchEntityIds,
  type EntityRef,
} from './audit-entity-refs';

/** Lima no tiene horario de verano (UTC-5 fijo): un offset literal alcanza, sin Intl. */
function limaStartOfDay(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000-05:00`);
}

/**
 * D-635 (cc48): el rango más largo que admite el visor, en días (12 meses de 30, con el día de
 * `to` incluido). Es el que usa el «Historial» de un documento cuando no trae fechas.
 */
const AUDIT_MAX_RANGE_DAYS = AUDIT_MAX_RANGE_MONTHS * 30 - 1;

interface RawEvent {
  source: AuditSource;
  id: string;
  occurredAt: Date;
  actorId: string | null;
  actorKind: 'USER' | 'SYSTEM';
  action: string;
  entityType: string;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
}

/** Una fila de `audit_log`, venga de Prisma o de la consulta del buscar. */
interface AuditLogRow {
  id: bigint;
  actorId: string | null;
  actorKind: 'USER' | 'SYSTEM';
  action: string;
  entity: string;
  entityId: string | null;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  reason: string | null;
  at: Date;
}

function auditLogEvent(r: AuditLogRow): RawEvent {
  return {
    source: 'audit_log',
    id: r.id.toString(),
    occurredAt: r.at,
    actorId: r.actorId,
    actorKind: r.actorKind,
    action: r.action,
    entityType: r.entity,
    entityId: r.entityId,
    before: (r.before as Record<string, unknown> | null) ?? null,
    after: (r.after as Record<string, unknown> | null) ?? null,
    reason: r.reason,
  };
}

/**
 * cc48 (D-634): el buscar ya resuelto. `refs`: los ids cuyo código legible coincide, por tipo de
 * entidad; `text`: el texto, para el detalle y el motivo, o `null` con un periodo de más de 31
 * días (`auditTextSearchApplies`): ahí el buscar encuentra solo por código.
 */
interface SearchMatch {
  refs: Map<AuditEntityType, string[]>;
  text: string | null;
}

interface Filters {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  /** cc48 (D-634): la acción exacta. */
  action?: string;
  /** cc48 (D-634): el buscar. */
  match?: SearchMatch;
  fromUtc: Date;
  toUtc: Date;
}

/** `%`, `_` y la barra invertida son comodines de ILIKE: el buscar los busca como texto. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Una fuente dedicada solo sirve si la acción pedida es la suya (su `action` es el nombre de la
 * fuente) o si no se pidió acción.
 */
function actionAllows(filters: Filters, source: AuditSource): boolean {
  return filters.action === undefined || filters.action === source;
}

/**
 * El tramo del cursor sobre la columna de fecha de una fuente: el mismo corte para las cuatro, con
 * el desempate por id de la fuente del cursor (`afterCursorWhere`).
 */
function rangeWhere<T>(
  filters: Filters,
  boundary: CursorBoundary | null,
  dateField: string,
  sameSourceId: () => T,
): Record<string, unknown> {
  if (boundary === null) return { [dateField]: { gte: filters.fromUtc, lt: filters.toUtc } };
  const at = new Date(boundary.occurredAt);
  if (boundary.mode === 'lt') return { [dateField]: { gte: filters.fromUtc, lt: at } };
  if (boundary.mode === 'lte') return { [dateField]: { gte: filters.fromUtc, lte: at } };
  return {
    OR: [
      { [dateField]: { gte: filters.fromUtc, lt: at } },
      { [dateField]: at, id: { lt: sameSourceId() } },
    ],
  };
}

/**
 * Visor de auditoría (D-218/RF-S2/M3): une `audit_log` con los tres changelogs dedicados en
 * una sola línea de tiempo, con paginación por cursor estable. Presupuesto de consultas fijo
 * por página: **una por fuente** (4), **una** para resolver nombres de actor y, cc48 (D-633),
 * **una por tipo de entidad** presente en la página para su código legible — nunca crece con el
 * número de filas ni con el rango de fechas (`audit-query.service.spec.ts` lo prueba). Con el
 * buscar (D-634), además una consulta por tipo para resolver el código a ids.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(query: AuditQuery): Promise<AuditPageDto> {
    const cursor = query.cursor ? this.decodeCursorOrThrow(query.cursor) : null;
    // D-635: abierto desde el detalle de un documento (con su id) y sin fechas, el rango es el
    // máximo (12 meses): el «Historial» de un pedido viejo no queda vacío por los 31 días.
    const { fromUtc, toUtc } = this.resolveRange(
      query.from,
      query.to,
      query.entityId !== undefined,
    );

    const filters: Filters = {
      entityType: query.entityType,
      entityId: query.entityId,
      actorId: query.actorId,
      action: query.action,
      match:
        query.search === undefined
          ? undefined
          : {
              refs: await searchEntityIds(this.prisma, query.search),
              text: auditTextSearchApplies(
                query.from,
                query.to,
                businessToday(),
                query.entityId !== undefined,
              )
                ? query.search
                : null,
            },
      fromUtc,
      toUtc,
    };

    const [auditLog, salesPrice, productListPrice, issueDate] = await Promise.all([
      this.fetchAuditLog(filters, cursor, query.pageSize),
      this.fetchSalesPriceChange(filters, cursor, query.pageSize),
      this.fetchProductListPriceChange(filters, cursor, query.pageSize),
      this.fetchIssueDateChange(filters, cursor, query.pageSize),
    ]);

    const merged = [...auditLog, ...salesPrice, ...productListPrice, ...issueDate].sort((a, b) => {
      const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
      if (byTime !== 0) return byTime;
      const byRank = sourceRank(a.source) - sourceRank(b.source);
      if (byRank !== 0) return byRank;
      // Mismo rank: mismo desempate que `afterCursorWhere` usa en el `where` de Prisma para
      // esta fuente — comparar como texto un `id` de `audit_log` (BigInt) es incorrecto en
      // cuanto los ids cruzan una cantidad de dígitos ("10" < "9" como texto), y desalinearía
      // el orden en memoria del que arma la página siguiente contra el `id: { lt: BigInt(...) } `
      // que de verdad corre en la base.
      return a.source === 'audit_log'
        ? BigInt(a.id) < BigInt(b.id)
          ? 1
          : -1
        : a.id < b.id
          ? 1
          : -1;
    });
    const page = merged.slice(0, query.pageSize);

    const hasMore =
      auditLog.length === query.pageSize ||
      salesPrice.length === query.pageSize ||
      productListPrice.length === query.pageSize ||
      issueDate.length === query.pageSize;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({
            occurredAt: last.occurredAt.toISOString(),
            source: last.source,
            id: last.id,
          })
        : null;

    // cc48 (D-633): nombres de actor y códigos de entidad, por lotes y en paralelo.
    const [actorNameById, refs] = await Promise.all([
      this.resolveActorNames(page.map((p) => p.actorId)),
      resolveEntityRefs(this.prisma, page),
    ]);
    return {
      items: page.map((p) => this.toDto(p, actorNameById, refs)),
      nextCursor,
    };
  }

  /**
   * cc48 (D-634): todas las filas del visor con estos filtros, para el Excel: las mismas páginas
   * de la pantalla, una tras otra, del tamaño máximo. Pasado el tope de exportación, 400.
   */
  async exportAll(query: AuditExportQuery): Promise<AuditEventDto[]> {
    const window = exportWindow();
    const rows: AuditEventDto[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.findPage({ ...query, cursor, pageSize: AUDIT_MAX_PAGE_SIZE });
      rows.push(...page.items);
      assertExportable(rows.length, window);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return rows;
  }

  /** `decodeCursor` tira un `Error` plano (no una `HttpException`): sin este envoltorio, un
   *  cursor inválido/crafteado a mano terminaba en 500 genérico en vez de un 400 de negocio. */
  private decodeCursorOrThrow(raw: string): AuditCursor {
    try {
      return decodeCursor(raw);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Cursor inválido');
    }
  }

  /**
   * Rango por defecto: los últimos 31 días (`widest`: los 12 meses, D-635). Tope: 12 meses — el
   * dueño lo pidió acotado.
   */
  private resolveRange(
    from: string | undefined,
    to: string | undefined,
    widest = false,
  ): { fromUtc: Date; toUtc: Date } {
    const today = businessToday();
    const toDate = to ?? today;
    const fromDate =
      from ?? addDays(toDate, widest ? -AUDIT_MAX_RANGE_DAYS : -AUDIT_DEFAULT_RANGE_DAYS);
    const fromUtc = limaStartOfDay(fromDate);
    // Límite superior EXCLUSIVO: el día siguiente a `to`, a las 00:00 Lima.
    const toUtc = limaStartOfDay(addDays(toDate, 1));
    const months = (toUtc.getTime() - fromUtc.getTime()) / (30 * 24 * 60 * 60 * 1000);
    if (months > AUDIT_MAX_RANGE_MONTHS) {
      throw new BadRequestException(
        `El rango no puede superar ${AUDIT_MAX_RANGE_MONTHS} meses (pediste ${fromDate} a ${toDate})`,
      );
    }
    if (fromUtc >= toUtc) {
      throw new BadRequestException('"from" tiene que ser anterior a "to"');
    }
    return { fromUtc, toUtc };
  }

  private async resolveActorNames(actorIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(actorIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toDto(
    row: RawEvent,
    actorNameById: Map<string, string>,
    refs: Map<string, EntityRef>,
  ): AuditEventDto {
    return {
      id: row.id,
      source: row.source,
      occurredAt: row.occurredAt.toISOString(),
      actorId: row.actorId,
      actorName: row.actorId ? (actorNameById.get(row.actorId) ?? null) : null,
      actorKind: row.actorKind,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      ...entityDisplay(row, refs),
      before: row.before,
      after: row.after,
      reason: row.reason,
    };
  }

  // -------------------------------------------------------------------------
  // Adaptadores por fuente — cada uno hace EXACTAMENTE una consulta. cc48: el tramo del cursor
  // lo arma `rangeWhere`, el mismo para las cuatro; el buscar y la acción se suman con `AND`.
  // -------------------------------------------------------------------------

  private async fetchAuditLog(
    filters: Filters,
    cursor: AuditCursor | null,
    limit: number,
  ): Promise<RawEvent[]> {
    const boundary = afterCursorWhere(sourceRank('audit_log'), cursor);
    if (filters.match !== undefined) {
      return this.searchAuditLog(filters, filters.match, boundary, limit);
    }
    const where: Prisma.AuditLogWhereInput = {
      ...(filters.entityType !== undefined ? { entity: filters.entityType } : {}),
      ...(filters.entityId !== undefined ? { entityId: filters.entityId } : {}),
      ...(filters.actorId !== undefined ? { actorId: filters.actorId } : {}),
      ...(filters.action !== undefined ? { action: filters.action } : {}),
      ...rangeWhere(filters, boundary, 'at', () =>
        BigInt(boundary?.mode === 'same-source' ? boundary.id : '0'),
      ),
    };
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(auditLogEvent);
  }

  /**
   * cc48 (D-634): `audit_log` con el buscar. El texto del detalle vive en `before`/`after` (JSON),
   * que Prisma no compara como texto: esta rama es la misma consulta de arriba —los mismos
   * filtros, el mismo corte del cursor, el mismo orden y tope— escrita en SQL de solo lectura, más
   * la coincidencia del buscar: el detalle o el motivo contienen el texto, o la entidad es una de
   * las que encontró su código legible. Sigue siendo **una** consulta por página.
   */
  private async searchAuditLog(
    filters: Filters,
    match: SearchMatch,
    boundary: CursorBoundary | null,
    limit: number,
  ): Promise<RawEvent[]> {
    const conds: Prisma.Sql[] = [Prisma.sql`at >= ${filters.fromUtc}`];
    if (boundary === null) conds.push(Prisma.sql`at < ${filters.toUtc}`);
    else if (boundary.mode === 'lt') conds.push(Prisma.sql`at < ${new Date(boundary.occurredAt)}`);
    else if (boundary.mode === 'lte') {
      conds.push(Prisma.sql`at <= ${new Date(boundary.occurredAt)}`);
    } else {
      const at = new Date(boundary.occurredAt);
      conds.push(Prisma.sql`(at < ${at} OR (at = ${at} AND id < ${BigInt(boundary.id)}))`);
    }
    if (filters.entityType !== undefined) conds.push(Prisma.sql`entity = ${filters.entityType}`);
    if (filters.entityId !== undefined) conds.push(Prisma.sql`entity_id = ${filters.entityId}`);
    if (filters.actorId !== undefined) {
      conds.push(Prisma.sql`actor_id = ${filters.actorId}::uuid`);
    }
    if (filters.action !== undefined) conds.push(Prisma.sql`action = ${filters.action}`);
    const pattern = match.text === null ? null : likePattern(match.text);
    const any: Prisma.Sql[] = [
      ...(pattern === null
        ? []
        : [
            Prisma.sql`before::text ILIKE ${pattern}`,
            Prisma.sql`after::text ILIKE ${pattern}`,
            Prisma.sql`reason ILIKE ${pattern}`,
          ]),
      ...[...match.refs.entries()].map(
        ([type, ids]) => Prisma.sql`(entity = ${type} AND entity_id IN (${Prisma.join(ids)}))`,
      ),
    ];
    // Sin texto (periodo largo) y sin ningún código que coincida, no hay nada que buscar.
    if (any.length === 0) return [];
    conds.push(Prisma.sql`(${Prisma.join(any, ' OR ')})`);
    const rows = await this.prisma.$queryRaw<AuditLogRow[]>`
      SELECT id, actor_id AS "actorId", actor_kind AS "actorKind", action, entity,
             entity_id AS "entityId", before, after, reason, at
        FROM audit_log
       WHERE ${Prisma.join(conds, ' AND ')}
       ORDER BY at DESC, id DESC
       LIMIT ${limit}`;
    return rows.map(auditLogEvent);
  }

  private async fetchSalesPriceChange(
    filters: Filters,
    cursor: AuditCursor | null,
    limit: number,
  ): Promise<RawEvent[]> {
    // Solo relevante para "sales_orders"/"quotations" (o sin filtro de tipo): D-187 vive en
    // una de esas dos FK, nunca las dos.
    if (
      (filters.entityType !== undefined &&
        filters.entityType !== 'sales_orders' &&
        filters.entityType !== 'quotations') ||
      !actionAllows(filters, 'sales_price_change')
    ) {
      return [];
    }
    // cc48 (D-634): sin texto propio, con el buscar solo entra por el código del documento.
    const orders = filters.match?.refs.get('sales_orders') ?? [];
    const quotations = filters.match?.refs.get('quotations') ?? [];
    if (filters.match !== undefined && orders.length === 0 && quotations.length === 0) return [];
    const boundary = afterCursorWhere(sourceRank('sales_price_change'), cursor);
    const where: Prisma.SalesPriceChangeWhereInput = {
      ...(filters.actorId !== undefined ? { changedById: filters.actorId } : {}),
      ...(filters.entityType === 'sales_orders' ? { salesOrderId: filters.entityId } : {}),
      ...(filters.entityType === 'quotations' ? { quotationId: filters.entityId } : {}),
      ...(filters.match === undefined
        ? {}
        : {
            AND: [
              {
                OR: [{ salesOrderId: { in: orders } }, { quotationId: { in: quotations } }],
              },
            ],
          }),
      ...rangeWhere(filters, boundary, 'changedAt', () =>
        boundary?.mode === 'same-source' ? boundary.id : '',
      ),
    };

    const rows = await this.prisma.salesPriceChange.findMany({
      where,
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((r) => ({
      source: 'sales_price_change',
      id: r.id,
      occurredAt: r.changedAt,
      actorId: r.changedById,
      actorKind: 'USER',
      action: 'sales_price_change',
      entityType: r.salesOrderId !== null ? 'sales_orders' : 'quotations',
      entityId: r.salesOrderId ?? r.quotationId,
      before: {
        lineNumber: r.lineNumber,
        unitValuePen: r.beforeUnitValuePen.toFixed(4),
        valuePerMeterPen: r.beforeValuePerMeterPen?.toFixed(4) ?? null,
      },
      after: {
        lineNumber: r.lineNumber,
        unitValuePen: r.afterUnitValuePen.toFixed(4),
        valuePerMeterPen: r.afterValuePerMeterPen?.toFixed(4) ?? null,
      },
      reason: null,
    }));
  }

  private async fetchProductListPriceChange(
    filters: Filters,
    cursor: AuditCursor | null,
    limit: number,
  ): Promise<RawEvent[]> {
    if (filters.entityType !== undefined && filters.entityType !== 'products') return [];
    if (!actionAllows(filters, 'product_list_price_change')) return [];
    const products = filters.match?.refs.get('products') ?? [];
    if (filters.match !== undefined && products.length === 0) return [];
    const boundary = afterCursorWhere(sourceRank('product_list_price_change'), cursor);
    const where: Prisma.ProductListPriceChangeWhereInput = {
      ...(filters.actorId !== undefined ? { changedById: filters.actorId } : {}),
      ...(filters.entityId !== undefined ? { productId: filters.entityId } : {}),
      ...(filters.match === undefined ? {} : { AND: [{ productId: { in: products } }] }),
      ...rangeWhere(filters, boundary, 'changedAt', () =>
        boundary?.mode === 'same-source' ? boundary.id : '',
      ),
    };

    const rows = await this.prisma.productListPriceChange.findMany({
      where,
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((r) => ({
      source: 'product_list_price_change',
      id: r.id,
      occurredAt: r.changedAt,
      actorId: r.changedById,
      actorKind: 'USER',
      action: 'product_list_price_change',
      entityType: 'products',
      entityId: r.productId,
      before: { valuePen: r.beforeValuePen?.toFixed(4) ?? null },
      after: {
        valuePen: r.afterValuePen?.toFixed(4) ?? null,
        origin: r.origin,
        batchId: r.batchId,
        revertsBatchId: r.revertsBatchId,
      },
      reason: null,
    }));
  }

  private async fetchIssueDateChange(
    filters: Filters,
    cursor: AuditCursor | null,
    limit: number,
  ): Promise<RawEvent[]> {
    if (filters.entityType !== undefined && filters.entityType !== 'fiscal_documents') return [];
    if (!actionAllows(filters, 'fiscal_document_issue_date_change')) return [];
    const boundary = afterCursorWhere(sourceRank('fiscal_document_issue_date_change'), cursor);
    // cc48 (D-634): el código del comprobante o, con periodo corto, el texto del motivo.
    const documents = filters.match?.refs.get('fiscal_documents') ?? [];
    const text = filters.match?.text ?? null;
    if (filters.match !== undefined && documents.length === 0 && text === null) return [];
    const where: Prisma.FiscalDocumentIssueDateChangeWhereInput = {
      ...(filters.actorId !== undefined ? { changedById: filters.actorId } : {}),
      ...(filters.entityId !== undefined ? { documentId: filters.entityId } : {}),
      ...(filters.match === undefined
        ? {}
        : {
            AND: [
              {
                OR: [
                  { documentId: { in: documents } },
                  ...(text === null
                    ? []
                    : [{ reason: { contains: text, mode: 'insensitive' as const } }]),
                ],
              },
            ],
          }),
      ...rangeWhere(filters, boundary, 'changedAt', () =>
        boundary?.mode === 'same-source' ? boundary.id : '',
      ),
    };

    const rows = await this.prisma.fiscalDocumentIssueDateChange.findMany({
      where,
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((r) => ({
      source: 'fiscal_document_issue_date_change',
      id: r.id,
      occurredAt: r.changedAt,
      actorId: r.changedById,
      actorKind: 'USER',
      action: 'fiscal_document_issue_date_change',
      entityType: 'fiscal_documents',
      entityId: r.documentId,
      before: {
        issueDate: r.beforeIssueDate.toISOString().slice(0, 10),
        dueDate: r.beforeDueDate?.toISOString().slice(0, 10) ?? null,
      },
      after: {
        issueDate: r.afterIssueDate.toISOString().slice(0, 10),
        dueDate: r.afterDueDate?.toISOString().slice(0, 10) ?? null,
      },
      reason: r.reason,
    }));
  }
}

/** Solo para el test de presupuesto de consultas: exactamente 4 fuentes + 1 lookup de actores. */
export const AUDIT_SOURCES_COUNT = AUDIT_SOURCES.length;
