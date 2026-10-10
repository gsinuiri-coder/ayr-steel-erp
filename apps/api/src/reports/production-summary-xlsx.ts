import { BUSINESS_LINE_LABELS, type ProductionSummaryDto } from '@ayr/shared';
import { assertExportable, exportWindow } from '../common/list-export';
import { UNITS_SYMBOL } from '../common/unit-symbol';
import { build, num, type Sheet } from './reports-xlsx';

/**
 * cc29 (M2). El reporte de producción en xlsx, del **mismo DTO** que la pantalla (con o sin
 * costos, según quien lo pide). Dos hojas: una fila por OP con el subtotal de cada pedido y el
 * total, y el detalle por bobina aparte, para ordenarlo y filtrarlo sin romper la otra.
 *
 * D-446: con más de `LIST_XLSX_MAX_ROWS` filas en una hoja, 400 «acota los filtros»; nunca un
 * archivo recortado.
 */
export function productionSummaryXlsx(
  report: ProductionSummaryDto,
  // cc40 (D-588): la búsqueda de la pantalla, al pie de la hoja por OP.
  notes: (string | number | null)[][] = [],
): {
  buffer: Buffer;
  filename: string;
} {
  const orderRows = report.groups.reduce((a, g) => a + g.orders.length, 0);
  const coilRows = report.groups.reduce(
    (a, g) => a + g.orders.reduce((b, o) => b + o.coils.length, 0),
    0,
  );
  // Las filas de la hoja «Por OP» son las OPs, un subtotal por pedido y el total.
  assertExportable(Math.max(orderRows + report.groups.length + 1, coilRows), exportWindow());

  const costHeader = report.withCosts ? ['Costo salido (S/)', 'Costo despunte (S/)'] : [];
  const costWidths = report.withCosts ? [16, 18] : [];
  const costs = (f: { materialCostPen: string | null; trimCostPen: string | null }) =>
    report.withCosts ? [num(f.materialCostPen), num(f.trimCostPen)] : [];
  const figures = (f: {
    theoreticalKg: string;
    consumedKg: string;
    trimKg: string;
    wastePct: string | null;
  }) => [num(f.theoreticalKg), num(f.consumedKg), num(f.trimKg), num(f.wastePct)];

  const orders: Sheet = {
    name: 'Por OP',
    header: [
      'OP',
      'Pedido',
      'Línea',
      'Producto',
      'Cantidad',
      'Unidad',
      'Kg teórico',
      'Kg salido',
      'Despunte (kg)',
      '% sobre el estándar',
      ...costHeader,
      'Bobinas',
    ],
    widths: [12, 12, 7, 36, 11, 7, 12, 12, 13, 18, ...costWidths, 40],
    rows: [
      ...report.groups.flatMap((g) => [
        ...g.orders.map((o) => [
          o.code,
          o.salesOrderCode ?? 'Sin pedido',
          o.lineNumber,
          `${o.productSku} · ${o.productName}`,
          num(o.quantity),
          // D-579: las piezas («pzs» en el DTO) se muestran como «und».
          o.quantityUnit === 'pzs' ? UNITS_SYMBOL : o.quantityUnit,
          ...figures(o),
          ...costs(o),
          o.coils.map((c) => c.code).join(', '),
        ]),
        [
          `Subtotal ${g.salesOrderCode ?? 'sin pedido'}`,
          null,
          null,
          null,
          null,
          null,
          ...figures(g.subtotal),
          ...costs(g.subtotal),
          null,
        ],
      ]),
      [
        `Total ${BUSINESS_LINE_LABELS[report.businessLine]} del ${report.from} al ${report.to} (${String(report.totals.orderCount)} OP)`,
        null,
        null,
        null,
        null,
        null,
        ...figures(report.totals),
        ...costs(report.totals),
        null,
      ],
      ...notes,
    ],
  };

  const coils: Sheet = {
    name: 'Por bobina',
    header: ['OP', 'Pedido', 'Bobina', 'Kg salido', 'Despunte (kg), repartido en orden de montaje'],
    widths: [12, 12, 36, 12, 40],
    rows: report.groups.flatMap((g) =>
      g.orders.flatMap((o) =>
        o.coils.map((c) => [
          o.code,
          o.salesOrderCode ?? 'Sin pedido',
          c.code,
          num(c.consumedKg),
          num(c.trimKg),
        ]),
      ),
    ),
  };

  return {
    buffer: build([orders, coils]),
    filename: `produccion-${report.businessLine}-${report.from}-${report.to}.xlsx`,
  };
}
