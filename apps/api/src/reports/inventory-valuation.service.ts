import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  Decimal,
  businessToday,
  toDecimal,
  toFixedString,
  type InventoryValuationCoilDto,
  type InventoryValuationCoilGroupDto,
  type InventoryValuationDto,
  type InventoryValuationLineTotalDto,
  type InventoryValuationProductDto,
} from '@ayr/shared';
import { fromDbLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';

/** Fila cruda de bobina con saldo, tal como sale de la consulta agregada. */
interface CoilBalanceRow {
  item_id: string;
  qty: Prisma.Decimal;
  avg_cost: Prisma.Decimal;
  business_line_code: string;
  code: string;
  type_key: string;
  kind: string;
  width_mm: Prisma.Decimal;
  thickness_mm: Prisma.Decimal;
  color_name: string | null;
  status: string;
  operation_date: Date;
}

/** Fila cruda de producto de catálogo con stock. */
interface ProductBalanceRow {
  item_id: string;
  qty: Prisma.Decimal;
  avg_cost: Prisma.Decimal;
  unit: string;
  business_line_code: string;
  sku: string;
  name: string;
}

interface MutableCoilGroup {
  key: string;
  businessLine: InventoryValuationCoilGroupDto['businessLine'];
  thicknessMm: string;
  colorName: string | null;
  qty: Decimal;
  value: Decimal;
  coils: InventoryValuationCoilDto[];
}

/**
 * Inventario valorizado a la fecha de corte (RF-S4a/M1).
 *
 * La fuente es `inventory_balances` —el saldo vigente con su costo promedio ponderado
 * (D-028)— y no una reconstrucción del kardex por fechas, porque el corte que este reporte
 * pide es **hoy**, que es exactamente lo que ese saldo significa. El reporte mensual de
 * bobinas (`/reports/coils`) sí reconstruye, porque pregunta por un mes ya cerrado: son dos
 * preguntas distintas y por eso no comparten consulta.
 *
 * Presupuesto de consultas: **dos, fijas** (bobinas y productos), sin importar cuántas
 * bobinas, productos, líneas o colores haya. El agrupado y la aritmética ocurren en memoria
 * sobre esas dos lecturas; nunca hay una consulta por grupo ni por fila.
 */
@Injectable()
export class InventoryValuationService {
  constructor(private readonly prisma: PrismaService) {}

  async valuation(): Promise<InventoryValuationDto> {
    // `qty <> 0`: un saldo en cero no es inventario y solo ensuciaría los grupos. Los
    // negativos —que no deberían existir— se dejan entrar a propósito: si alguna vez
    // aparece uno, este reporte es el lugar donde se ve, no otro donde se esconde.
    const coilRows = await this.prisma.$queryRaw<CoilBalanceRow[]>`
      SELECT
        b."item_id",
        b."qty",
        b."avg_cost",
        bl."code"::text  AS "business_line_code",
        c."code",
        c."type_key",
        c."kind"::text   AS "kind",
        c."width_mm",
        c."thickness_mm",
        col."name"       AS "color_name",
        c."status"::text AS "status",
        c."operation_date"
      FROM "inventory_balances" b
      JOIN "coils" c ON c."id" = b."item_id"
      JOIN "business_lines" bl ON bl."id" = c."business_line_id"
      LEFT JOIN "colors" col ON col."id" = c."color_id"
      WHERE b."item_type" = 'COIL' AND b."qty" <> 0
      ORDER BY bl."code" ASC, c."thickness_mm" ASC, col."name" ASC NULLS FIRST, c."code" ASC
    `;

    const productRows = await this.prisma.$queryRaw<ProductBalanceRow[]>`
      SELECT
        b."item_id",
        b."qty",
        b."avg_cost",
        b."unit",
        bl."code"::text AS "business_line_code",
        p."sku",
        p."name"
      FROM "inventory_balances" b
      JOIN "products" p ON p."id" = b."item_id"
      JOIN "business_lines" bl ON bl."id" = p."business_line_id"
      WHERE b."item_type" = 'PRODUCT' AND b."qty" <> 0
      ORDER BY bl."code" ASC, p."sku" ASC
    `;

    const groups = new Map<string, MutableCoilGroup>();
    for (const r of coilRows) {
      const qty = toDecimal(r.qty.toString());
      const avgCost = toDecimal(r.avg_cost.toString());
      // El valor se calcula **por bobina y sin redondear** antes de acumular: redondear cada
      // grupo y después sumarlos deja el total distinto de la suma de sus filas, que es
      // exactamente lo que la conciliación contra el kardex detecta.
      const value = qty.times(avgCost);
      const businessLine = fromDbLineCode(r.business_line_code);
      const thicknessMm = r.thickness_mm.toFixed(2);
      const key = `${businessLine}|${thicknessMm}|${r.color_name ?? ''}`;

      const coil: InventoryValuationCoilDto = {
        id: r.item_id,
        code: r.code,
        typeKey: r.type_key,
        kind: r.kind as InventoryValuationCoilDto['kind'],
        widthMm: r.width_mm.toFixed(2),
        qtyKg: qty.toFixed(3),
        avgCostPen: avgCost.toFixed(4),
        totalValuePen: toFixedString(value, 'MONEY'),
        status: r.status as InventoryValuationCoilDto['status'],
        operationDate: r.operation_date.toISOString().slice(0, 10),
      };

      const current = groups.get(key);
      if (current) {
        current.qty = current.qty.plus(qty);
        current.value = current.value.plus(value);
        current.coils.push(coil);
      } else {
        groups.set(key, {
          key,
          businessLine,
          thicknessMm,
          colorName: r.color_name,
          qty,
          value,
          coils: [coil],
        });
      }
    }

    const coilGroups: InventoryValuationCoilGroupDto[] = [...groups.values()].map((g) => ({
      key: g.key,
      businessLine: g.businessLine,
      thicknessMm: g.thicknessMm,
      colorName: g.colorName,
      coilCount: g.coils.length,
      qtyKg: g.qty.toFixed(3),
      // Valor total / cantidad total, y no promedio de promedios: dos bobinas del mismo
      // grupo con pesos distintos tienen que pesar distinto en el costo agregado (RF-51).
      avgCostPen: toFixedString(g.qty.isZero() ? new Decimal(0) : g.value.div(g.qty), 'MONEY'),
      totalValuePen: toFixedString(g.value, 'MONEY'),
      coils: g.coils,
    }));

    const products: InventoryValuationProductDto[] = productRows.map((r) => {
      const qty = toDecimal(r.qty.toString());
      const avgCost = toDecimal(r.avg_cost.toString());
      return {
        itemId: r.item_id,
        businessLine: fromDbLineCode(r.business_line_code),
        sku: r.sku,
        name: r.name,
        qty: qty.toFixed(3),
        unit: r.unit,
        avgCostPen: avgCost.toFixed(4),
        totalValuePen: toFixedString(qty.times(avgCost), 'MONEY'),
      };
    });

    // Los totales por línea se acumulan desde los mismos `Decimal` sin redondear con los que
    // se armaron las filas, por el mismo motivo.
    const byLine = new Map<string, { coil: Decimal; product: Decimal }>();
    const bucket = (line: string): { coil: Decimal; product: Decimal } => {
      const found = byLine.get(line);
      if (found) return found;
      const fresh = { coil: new Decimal(0), product: new Decimal(0) };
      byLine.set(line, fresh);
      return fresh;
    };
    for (const g of groups.values()) {
      const b = bucket(g.businessLine);
      b.coil = b.coil.plus(g.value);
    }
    for (const r of productRows) {
      const line = fromDbLineCode(r.business_line_code);
      const b = bucket(line);
      b.product = b.product.plus(
        toDecimal(r.qty.toString()).times(toDecimal(r.avg_cost.toString())),
      );
    }

    let coilTotal = new Decimal(0);
    let productTotal = new Decimal(0);
    const totalsByLine: InventoryValuationLineTotalDto[] = [...byLine.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([line, v]) => {
        coilTotal = coilTotal.plus(v.coil);
        productTotal = productTotal.plus(v.product);
        return {
          businessLine: line as InventoryValuationLineTotalDto['businessLine'],
          coilValuePen: toFixedString(v.coil, 'MONEY'),
          productValuePen: toFixedString(v.product, 'MONEY'),
          totalValuePen: toFixedString(v.coil.plus(v.product), 'MONEY'),
        };
      });

    return {
      asOf: businessToday(),
      coilGroups,
      products,
      totalsByLine,
      totals: {
        coilValuePen: toFixedString(coilTotal, 'MONEY'),
        productValuePen: toFixedString(productTotal, 'MONEY'),
        totalValuePen: toFixedString(coilTotal.plus(productTotal), 'MONEY'),
      },
    };
  }
}
