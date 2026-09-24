import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { InventoryRefType } from '@prisma/client';
import {
  dispatchCode,
  fromDateOnly,
  INVENTORY_REF_TYPE_LABELS,
  productionOrderCode,
  toDateOnly,
  type KardexPepsQuery,
} from '@ayr/shared';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { valuePeps, type PepsResult } from './kardex-peps';

/** Documento de la fila (tabla 10 de SUNAT) y tipo de operación (tabla 12). */
export interface KardexPepsDocument {
  docTypeCode: string;
  series: string;
  number: string;
  operationCode: string;
  operationLabel: string;
  note: string | null;
}

export interface KardexPepsReport {
  from: string;
  to: string;
  companyRuc: string;
  companyName: string;
  itemCode: string;
  itemDescription: string;
  /** Tabla 5. */
  existenceType: string;
  /** Tabla 6. */
  unitCode: string;
  peps: PepsResult;
  /** Por `movementId` de cada fila del rango. */
  documents: Map<string, KardexPepsDocument>;
}

/** Tabla 6 (unidad de medida) desde el catálogo 03 que guarda el kardex. */
const UNIT_TABLE_6: Record<string, string> = {
  KGM: '01 - KILOGRAMOS',
  NIU: '07 - UNIDADES',
  MTR: '15 - METROS',
};

/** Tabla 10, desde los tipos de comprobante del sistema. `00` = documento interno u otro. */
const DOC_TABLE_10: Record<string, string> = {
  FACTURA: '01',
  BOLETA: '03',
  NOTA_CREDITO: '07',
  NOTA_DEBITO: '08',
  GUIA_REMISION_REMITENTE: '09',
};

/**
 * Tabla 12 (tipo de operación) por origen y sentido del movimiento. Las anulaciones y el
 * ajuste de costo (D-043) no tienen código propio: van como `99 - OTROS` con su motivo en la
 * observación, que es más honesto que forzarlos a una devolución que no ocurrió.
 */
function operationOf(
  refType: InventoryRefType,
  type: 'IN' | 'OUT' | 'ADJUST',
  isReversal: boolean,
): { code: string; label: string } {
  const other = { code: '99', label: 'OTROS' };
  if (isReversal || type === 'ADJUST') return other;
  const inbound = type === 'IN';
  switch (refType) {
    case 'PURCHASE':
      return inbound ? { code: '02', label: 'COMPRA' } : other;
    case 'SALE':
      return inbound ? other : { code: '01', label: 'VENTA' };
    case 'PRODUCTION':
      return inbound
        ? { code: '19', label: 'ENTRADA DE PRODUCCIÓN' }
        : { code: '10', label: 'SALIDA A PRODUCCIÓN' };
    case 'CUTTING':
      return inbound
        ? { code: '26', label: 'ENTRADA PARA SERVICIO DE PRODUCCIÓN' }
        : { code: '27', label: 'SALIDA POR SERVICIO DE PRODUCCIÓN' };
    case 'SCRAP':
      return { code: '13', label: 'MERMAS' };
    case 'CLOSE_ADJUSTMENT':
    case 'ADJUSTMENT':
      return { code: '28', label: 'AJUSTE POR DIFERENCIA DE INVENTARIO' };
    case 'IMPORT':
      return inbound ? { code: '16', label: 'SALDO INICIAL' } : other;
    default:
      return other;
  }
}

/** `F001-00000123` → serie y número. Sin guion, todo es número. */
function splitNumber(value: string | null): { series: string; number: string } {
  if (!value) return { series: '', number: '' };
  const dash = value.indexOf('-');
  return dash < 0
    ? { series: '', number: value }
    : { series: value.slice(0, dash), number: value.slice(dash + 1) };
}

/**
 * D-279 — Kardex PEPS de un ítem en el formato 13.1 de SUNAT. Solo lectura; lee los mismos
 * movimientos que `/kardex` y no escribe ni cambia ninguna valorización.
 *
 * Presupuesto de consultas fijo: el ítem, sus movimientos hasta `to` y una consulta por tipo
 * de documento referido (despachos, comprobantes, compras, reportes de producción), sin N+1.
 */
@Injectable()
export class KardexPepsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async report(query: KardexPepsQuery): Promise<KardexPepsReport> {
    const item = await this.itemOf(query);
    const movements = await this.prisma.inventoryMovement.findMany({
      where: {
        itemType: query.itemType,
        itemId: query.itemId,
        operationDate: { lte: toDateOnly(query.to) },
      },
      // El mismo orden que el saldo corrido del kardex (D-124): fecha de operación, instante
      // de grabación y el id bigserial para desempatar.
      orderBy: [{ operationDate: 'asc' }, { at: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        type: true,
        qty: true,
        unit: true,
        totalCost: true,
        refType: true,
        refId: true,
        notes: true,
        reversalOfId: true,
        operationDate: true,
      },
    });

    const peps = valuePeps(
      movements.map((m) => ({
        id: m.id.toString(),
        type: m.type,
        qty: m.qty.toString(),
        totalCost: m.totalCost.toString(),
        operationDate: fromDateOnly(m.operationDate),
        reversalOfId: m.reversalOfId === null ? null : m.reversalOfId.toString(),
      })),
      query.from,
      query.to,
    );

    const inRange = movements.filter((m) => fromDateOnly(m.operationDate) >= query.from);
    const documents = await this.documentsOf(inRange);
    const unit = movements[0]?.unit ?? item.unit;

    return {
      from: query.from,
      to: query.to,
      companyRuc: this.env.COMPANY_RUC,
      companyName: this.env.COMPANY_LEGAL_NAME,
      itemCode: item.code,
      itemDescription: item.description,
      existenceType: item.existenceType,
      unitCode: UNIT_TABLE_6[unit] ?? `99 - OTROS (${unit})`,
      peps,
      documents,
    };
  }

  private async itemOf(query: KardexPepsQuery): Promise<{
    code: string;
    description: string;
    existenceType: string;
    unit: string;
  }> {
    if (query.itemType === 'PRODUCT') {
      const product = await this.prisma.product.findUnique({
        where: { id: query.itemId },
        select: { sku: true, name: true, unit: true, source: true },
      });
      if (!product) throw new NotFoundException('Producto no encontrado');
      return {
        code: product.sku,
        description: product.name,
        // Lo comprado para revender es mercadería; lo que sale de planta, producto terminado.
        existenceType:
          product.source === 'PURCHASED' ? '01 - MERCADERÍAS' : '02 - PRODUCTOS TERMINADOS',
        unit: product.unit,
      };
    }
    const coil = await this.prisma.coil.findUnique({
      where: { id: query.itemId },
      select: { code: true, typeKey: true },
    });
    if (!coil) throw new NotFoundException('Bobina no encontrada');
    return {
      code: coil.code,
      description: `Bobina ${coil.typeKey}`,
      existenceType: '03 - MATERIAS PRIMAS',
      unit: 'KGM',
    };
  }

  private async documentsOf(
    rows: {
      id: bigint;
      type: 'IN' | 'OUT' | 'ADJUST';
      refType: InventoryRefType;
      refId: string | null;
      notes: string | null;
      reversalOfId: bigint | null;
    }[],
  ): Promise<Map<string, KardexPepsDocument>> {
    const idsOf = (refType: InventoryRefType): string[] => [
      ...new Set(rows.flatMap((r) => (r.refType === refType && r.refId !== null ? [r.refId] : []))),
    ];
    const saleIds = idsOf('SALE');
    const purchaseIds = idsOf('PURCHASE');
    const productionIds = idsOf('PRODUCTION');
    const [dispatches, purchases, reports, orders] = await Promise.all([
      saleIds.length
        ? this.prisma.dispatch.findMany({
            where: { id: { in: saleIds } },
            select: { id: true, seq: true, invoiceId: true },
          })
        : Promise.resolve([]),
      purchaseIds.length
        ? this.prisma.purchase.findMany({
            where: { id: { in: purchaseIds } },
            select: { id: true, docType: true, series: true, number: true },
          })
        : Promise.resolve([]),
      productionIds.length
        ? this.prisma.productionReport.findMany({
            where: { id: { in: productionIds } },
            select: { id: true, productionOrder: { select: { seq: true } } },
          })
        : Promise.resolve([]),
      // Algún movimiento viejo de producción apunta a la OP y no al reporte (ver
      // `resolveRefTargets` del kardex).
      productionIds.length
        ? this.prisma.productionOrder.findMany({
            where: { id: { in: productionIds } },
            select: { id: true, seq: true },
          })
        : Promise.resolve([]),
    ]);
    const invoiceIds = [
      ...new Set(dispatches.map((d) => d.invoiceId).filter((id): id is string => id !== null)),
    ];
    const invoices = invoiceIds.length
      ? await this.prisma.fiscalDocument.findMany({
          where: { id: { in: invoiceIds } },
          select: { id: true, docType: true, number: true },
        })
      : [];

    const dispatchById = new Map(dispatches.map((d) => [d.id, d]));
    const invoiceById = new Map(invoices.map((i) => [i.id, i]));
    const purchaseById = new Map(purchases.map((p) => [p.id, p]));
    const orderSeqById = new Map([
      ...orders.map((o) => [o.id, o.seq] as const),
      ...reports.map((r) => [r.id, r.productionOrder.seq] as const),
    ]);

    const result = new Map<string, KardexPepsDocument>();
    for (const r of rows) {
      const isReversal = r.reversalOfId !== null;
      const operation = operationOf(r.refType, r.type, isReversal);
      let docTypeCode = '00';
      let series = '';
      let number = '';
      if (r.refType === 'SALE' && r.refId) {
        const dispatch = dispatchById.get(r.refId);
        const invoice = dispatch?.invoiceId ? invoiceById.get(dispatch.invoiceId) : undefined;
        if (invoice) {
          docTypeCode = DOC_TABLE_10[invoice.docType] ?? '00';
          ({ series, number } = splitNumber(invoice.number));
        } else if (dispatch) {
          number = dispatchCode(dispatch.seq);
        }
      } else if (r.refType === 'PURCHASE' && r.refId) {
        const purchase = purchaseById.get(r.refId);
        if (purchase) {
          docTypeCode = DOC_TABLE_10[purchase.docType] ?? '00';
          series = purchase.series;
          number = purchase.number;
        }
      } else if (r.refType === 'PRODUCTION' && r.refId) {
        const seq = orderSeqById.get(r.refId);
        if (seq !== undefined) number = productionOrderCode(seq);
      }
      const origin = INVENTORY_REF_TYPE_LABELS[r.refType];
      const detail = isReversal
        ? `Anulación (${origin})`
        : r.type === 'ADJUST'
          ? `Ajuste de costo (${origin})`
          : origin;
      result.set(r.id.toString(), {
        docTypeCode,
        series,
        number,
        operationCode: operation.code,
        operationLabel: operation.label,
        note: r.notes ? `${detail}: ${r.notes}` : detail,
      });
    }
    return result;
  }
}
