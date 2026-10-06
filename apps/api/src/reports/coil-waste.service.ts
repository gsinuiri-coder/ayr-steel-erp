import { Injectable } from '@nestjs/common';
import {
  BusinessLine,
  fromDateOnly,
  toDateOnly,
  toDecimal,
  toleranceOverrideLabel,
  type CoilWasteDto,
  type CoilWasteQuery,
} from '@ayr/shared';
import { toPrismaLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';
import {
  TOLERANCE_OVERRIDE_AUDIT_ACTION,
  toleranceOverrideAuditSchema,
} from '../production/production-shared';
import {
  assembleCoilWaste,
  type WasteCoil,
  type WasteMovement,
  type WasteReport,
  type WasteToleranceOverride,
} from './coil-waste';

/**
 * cc25 (D-424, D-425, D-429..D-431, D-433). Merma por bobina. Solo lectura y solo administrador
 * (D-426, en el controlador): no escribe kardex ni cambia cómo se calcula el costo.
 *
 * **Consultas fijas**, sin importar cuántas bobinas o reportes haya: los movimientos del rango
 * (una), las bobinas, los reportes, las órdenes, las autorizaciones de tolerancia y las ventas
 * enteras (una cada una, y ninguna si no hay producción en el rango). Seis como máximo.
 */
@Injectable()
export class CoilWasteService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: CoilWasteQuery): Promise<CoilWasteDto> {
    const businessLine = query.businessLine ?? BusinessLine.METALLIC_ROOFING;
    const base = { from: query.from, to: query.to, businessLine };

    // D-429: los movimientos vivos del rango (el criterio de D-291: ni anulados ni la anulación
    // de otro), de la línea de la pestaña.
    const rawMovements = await this.prisma.inventoryMovement.findMany({
      where: {
        itemType: 'COIL',
        refType: { in: ['PRODUCTION', 'SCRAP', 'CLOSE_ADJUSTMENT'] },
        operationDate: { gte: toDateOnly(query.from), lte: toDateOnly(query.to) },
        businessLine: { code: toPrismaLineCode(businessLine) },
        reversalOfId: null,
        reversals: { none: {} },
      },
      select: {
        itemId: true,
        type: true,
        qty: true,
        refType: true,
        refId: true,
        operationDate: true,
      },
      orderBy: { id: 'asc' },
    });
    const movements: WasteMovement[] = rawMovements.map((m) => ({
      itemId: m.itemId,
      type: m.type,
      qty: toDecimal(m.qty.toString()),
      refType: m.refType as WasteMovement['refType'],
      refId: m.refId,
      operationDate: fromDateOnly(m.operationDate),
    }));

    const production = movements.filter((m) => m.refType === 'PRODUCTION');
    const coilIds = [...new Set(production.map((m) => m.itemId))];
    if (coilIds.length === 0) {
      return assembleCoilWaste({
        ...base,
        movements: [],
        coils: new Map(),
        reports: new Map(),
        overrides: new Map(),
        soldCoilIds: new Set(),
      });
    }
    const reportIds = [
      ...new Set(production.map((m) => m.refId).filter((id): id is string => isUuid(id))),
    ];

    const [coilRows, reportRows, soldRows] = await Promise.all([
      this.prisma.coil.findMany({
        where: { id: { in: coilIds } },
        select: {
          id: true,
          code: true,
          kind: true,
          typeKey: true,
          widthMm: true,
          status: true,
          color: { select: { name: true } },
        },
      }),
      reportIds.length === 0
        ? Promise.resolve([])
        : this.prisma.productionReport.findMany({
            where: { id: { in: reportIds } },
            select: {
              id: true,
              theoreticalKg: true,
              operationDate: true,
              productionOrderId: true,
              productionOrder: { select: { seq: true } },
            },
          }),
      // D-424: la bobina vendida entera no entra, cualquiera sea la fecha de la venta.
      this.prisma.inventoryMovement.findMany({
        where: {
          itemType: 'COIL',
          itemId: { in: coilIds },
          refType: 'SALE',
          type: 'OUT',
          reversalOfId: null,
          reversals: { none: {} },
        },
        select: { itemId: true },
      }),
    ]);

    const orderIds = [...new Set(reportRows.map((r) => r.productionOrderId))];
    const auditRows =
      orderIds.length === 0
        ? []
        : await this.prisma.auditLog.findMany({
            where: {
              entity: 'production_orders',
              entityId: { in: orderIds },
              action: TOLERANCE_OVERRIDE_AUDIT_ACTION,
            },
            select: { after: true },
          });

    const coils = new Map<string, WasteCoil>(
      coilRows.map((c) => [
        c.id,
        {
          code: c.code,
          kind: c.kind,
          typeKey: c.typeKey,
          colorName: c.color?.name ?? null,
          widthMm: c.widthMm.toFixed(2),
          status: c.status,
        },
      ]),
    );
    const reports = new Map<string, WasteReport>(
      reportRows.map((r) => [
        r.id,
        {
          theoreticalKg: toDecimal(r.theoreticalKg.toString()),
          productionOrderId: r.productionOrderId,
          orderSeq: r.productionOrder.seq,
          operationDate: fromDateOnly(r.operationDate),
        },
      ]),
    );
    // D-388/D-389: la casilla vive en la auditoría de la orden, no en una columna.
    const overrides = new Map<string, WasteToleranceOverride>();
    for (const row of auditRows) {
      const parsed = toleranceOverrideAuditSchema.safeParse(row.after);
      if (!parsed.success) continue;
      const { reportId, reason, detail, differencePct } = parsed.data;
      overrides.set(reportId, {
        label: toleranceOverrideLabel({ reason, ...(detail === null ? {} : { detail }) }),
        excessPct: differencePct,
      });
    }

    return assembleCoilWaste({
      ...base,
      movements,
      coils,
      reports,
      overrides,
      soldCoilIds: new Set(soldRows.map((r) => r.itemId)),
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `refId` es texto libre: solo un uuid puede ser el id de un reporte. */
function isUuid(value: string | null): value is string {
  return value !== null && UUID.test(value);
}
