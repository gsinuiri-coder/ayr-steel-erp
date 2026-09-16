import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  addDays,
  businessToday,
  AUDIT_DEFAULT_RANGE_DAYS,
  AUDIT_MAX_RANGE_MONTHS,
  AUDIT_SOURCES,
  type AuditEventDto,
  type AuditPageDto,
  type AuditQuery,
  type AuditSource,
} from '@ayr/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  afterCursorWhere,
  decodeCursor,
  encodeCursor,
  sourceRank,
  type AuditCursor,
} from './audit-cursor';

/** Lima no tiene horario de verano (UTC-5 fijo): un offset literal alcanza, sin Intl. */
function limaStartOfDay(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000-05:00`);
}

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

interface Filters {
  entityType?: string;
  entityId?: string;
  actorId?: string;
  fromUtc: Date;
  toUtc: Date;
}

/**
 * Visor de auditoría (D-218/RF-S2/M3): une `audit_log` con los tres changelogs dedicados en
 * una sola línea de tiempo, con paginación por cursor estable. Presupuesto de consultas fijo
 * por página: **una por fuente** (4) más **una** para resolver nombres de actor — nunca crece
 * con el número de filas ni con el rango de fechas (`audit-query.service.spec.ts` lo prueba).
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(query: AuditQuery): Promise<AuditPageDto> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const { fromUtc, toUtc } = this.resolveRange(query.from, query.to);

    const filters: Filters = {
      entityType: query.entityType,
      entityId: query.entityId,
      actorId: query.actorId,
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
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
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

    const actorNameById = await this.resolveActorNames(page.map((p) => p.actorId));
    return {
      items: page.map((p) => this.toDto(p, actorNameById)),
      nextCursor,
    };
  }

  /** Rango por defecto: los últimos 31 días. Tope: 12 meses — el dueño lo pidió acotado. */
  private resolveRange(
    from: string | undefined,
    to: string | undefined,
  ): { fromUtc: Date; toUtc: Date } {
    const today = businessToday();
    const toDate = to ?? today;
    const fromDate = from ?? addDays(toDate, -AUDIT_DEFAULT_RANGE_DAYS);
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

  private toDto(row: RawEvent, actorNameById: Map<string, string>): AuditEventDto {
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
      before: row.before,
      after: row.after,
      reason: row.reason,
    };
  }

  // -------------------------------------------------------------------------
  // Adaptadores por fuente — cada uno hace EXACTAMENTE una consulta. El `where` se arma
  // completo en cada rama (nunca se lee de vuelta un campo ya asignado) a propósito: Prisma
  // tipa `at`/`changedAt` como una unión (filtro u objeto de igualdad) y leerla de vuelta
  // para "agregarle" una condición no tipa limpio — más simple armar el objeto entero una
  // sola vez por rama.
  // -------------------------------------------------------------------------

  private async fetchAuditLog(
    filters: Filters,
    cursor: AuditCursor | null,
    limit: number,
  ): Promise<RawEvent[]> {
    const boundary = afterCursorWhere(sourceRank('audit_log'), cursor);
    const base: Prisma.AuditLogWhereInput = {
      ...(filters.entityType !== undefined ? { entity: filters.entityType } : {}),
      ...(filters.entityId !== undefined ? { entityId: filters.entityId } : {}),
      ...(filters.actorId !== undefined ? { actorId: filters.actorId } : {}),
    };
    const where: Prisma.AuditLogWhereInput =
      boundary === null
        ? { ...base, at: { gte: filters.fromUtc, lt: filters.toUtc } }
        : boundary.mode === 'lt'
          ? { ...base, at: { gte: filters.fromUtc, lt: new Date(boundary.occurredAt) } }
          : boundary.mode === 'lte'
            ? { ...base, at: { gte: filters.fromUtc, lte: new Date(boundary.occurredAt) } }
            : {
                ...base,
                OR: [
                  { at: { gte: filters.fromUtc, lt: new Date(boundary.occurredAt) } },
                  { at: new Date(boundary.occurredAt), id: { lt: BigInt(boundary.id) } },
                ],
              };

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((r) => ({
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
    }));
  }

  private async fetchSalesPriceChange(
    filters: Filters,
    cursor: AuditCursor | null,
    limit: number,
  ): Promise<RawEvent[]> {
    // Solo relevante para "sales_orders"/"quotations" (o sin filtro de tipo): D-187 vive en
    // una de esas dos FK, nunca las dos.
    if (
      filters.entityType !== undefined &&
      filters.entityType !== 'sales_orders' &&
      filters.entityType !== 'quotations'
    ) {
      return [];
    }
    const boundary = afterCursorWhere(sourceRank('sales_price_change'), cursor);
    const base: Prisma.SalesPriceChangeWhereInput = {
      ...(filters.actorId !== undefined ? { changedById: filters.actorId } : {}),
      ...(filters.entityType === 'sales_orders' ? { salesOrderId: filters.entityId } : {}),
      ...(filters.entityType === 'quotations' ? { quotationId: filters.entityId } : {}),
    };
    const where: Prisma.SalesPriceChangeWhereInput =
      boundary === null
        ? { ...base, changedAt: { gte: filters.fromUtc, lt: filters.toUtc } }
        : boundary.mode === 'lt'
          ? { ...base, changedAt: { gte: filters.fromUtc, lt: new Date(boundary.occurredAt) } }
          : boundary.mode === 'lte'
            ? { ...base, changedAt: { gte: filters.fromUtc, lte: new Date(boundary.occurredAt) } }
            : {
                ...base,
                OR: [
                  { changedAt: { gte: filters.fromUtc, lt: new Date(boundary.occurredAt) } },
                  { changedAt: new Date(boundary.occurredAt), id: { lt: boundary.id } },
                ],
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
    const boundary = afterCursorWhere(sourceRank('product_list_price_change'), cursor);
    const base: Prisma.ProductListPriceChangeWhereInput = {
      ...(filters.actorId !== undefined ? { changedById: filters.actorId } : {}),
      ...(filters.entityId !== undefined ? { productId: filters.entityId } : {}),
    };
    const where: Prisma.ProductListPriceChangeWhereInput =
      boundary === null
        ? { ...base, changedAt: { gte: filters.fromUtc, lt: filters.toUtc } }
        : boundary.mode === 'lt'
          ? { ...base, changedAt: { gte: filters.fromUtc, lt: new Date(boundary.occurredAt) } }
          : boundary.mode === 'lte'
            ? { ...base, changedAt: { gte: filters.fromUtc, lte: new Date(boundary.occurredAt) } }
            : {
                ...base,
                OR: [
                  { changedAt: { gte: filters.fromUtc, lt: new Date(boundary.occurredAt) } },
                  { changedAt: new Date(boundary.occurredAt), id: { lt: boundary.id } },
                ],
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
    const boundary = afterCursorWhere(sourceRank('fiscal_document_issue_date_change'), cursor);
    const base: Prisma.FiscalDocumentIssueDateChangeWhereInput = {
      ...(filters.actorId !== undefined ? { changedById: filters.actorId } : {}),
      ...(filters.entityId !== undefined ? { documentId: filters.entityId } : {}),
    };
    const where: Prisma.FiscalDocumentIssueDateChangeWhereInput =
      boundary === null
        ? { ...base, changedAt: { gte: filters.fromUtc, lt: filters.toUtc } }
        : boundary.mode === 'lt'
          ? { ...base, changedAt: { gte: filters.fromUtc, lt: new Date(boundary.occurredAt) } }
          : boundary.mode === 'lte'
            ? { ...base, changedAt: { gte: filters.fromUtc, lte: new Date(boundary.occurredAt) } }
            : {
                ...base,
                OR: [
                  { changedAt: { gte: filters.fromUtc, lt: new Date(boundary.occurredAt) } },
                  { changedAt: new Date(boundary.occurredAt), id: { lt: boundary.id } },
                ],
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
