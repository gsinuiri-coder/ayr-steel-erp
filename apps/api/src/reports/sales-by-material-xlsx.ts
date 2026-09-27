import {
  Decimal,
  SALES_MATERIAL_KIND_LABELS,
  toDecimal,
  toFixedString,
  SALES_MATERIAL_UNTRACEABLE_LABELS,
  type SalesByMaterialDto,
  type SalesMaterialFiguresDto,
  type SalesMaterialKind,
} from '@ayr/shared';
import { build, num, type Sheet } from './reports-xlsx';

/**
 * D-354 — «Ventas por material» en xlsx, del mismo DTO que la pantalla. Tres hojas: el reporte
 * con sus subtotales y total (las columnas de la planilla del cliente), el modal «cuántas
 * bobinas» desglosado por bobina × tipo, y lo no trazable con su motivo.
 */
const FIGURE_HEADER = [
  'ML vendido',
  'Peso teórico (kg)',
  'Peso real (kg)',
  'Rendimiento (kg)',
  'Rendimiento %',
  'Venta sin IGV (S/)',
  'Costo de producción (S/)',
  'Utilidad (S/)',
  'Costo/kg compra (S/)',
  'Precio/kg venta (S/)',
  'Margen/kg (S/)',
];

function figureCells(f: SalesMaterialFiguresDto): (number | null)[] {
  return [
    num(f.metersSold),
    num(f.theoreticalKg),
    num(f.realKg),
    num(f.yieldKg),
    num(f.yieldPct),
    num(f.salesPen),
    num(f.costPen),
    num(f.profitPen),
    num(f.costPerKgPen),
    num(f.pricePerKgPen),
    num(f.marginPerKgPen),
  ];
}

export function salesByMaterialXlsx(report: SalesByMaterialDto): {
  buffer: Buffer;
  filename: string;
} {
  const main: Sheet = {
    name: 'Ventas por material',
    header: ['Tipo', 'Espesor (mm)', 'Color', ...FIGURE_HEADER],
    widths: [22, 12, 16, 12, 16, 14, 15, 13, 17, 21, 14, 18, 18, 14],
    rows: [],
  };
  for (const sub of report.subtotals) {
    for (const row of report.rows.filter((r) => r.kind === sub.kind)) {
      main.rows.push([
        SALES_MATERIAL_KIND_LABELS[row.kind],
        num(row.thicknessMm),
        row.colorLabel,
        ...figureCells(row),
      ]);
    }
    main.rows.push([
      `Subtotal ${SALES_MATERIAL_KIND_LABELS[sub.kind]}`,
      null,
      '',
      ...figureCells(sub),
    ]);
  }
  main.rows.push(['Total', null, '', ...figureCells(report.total)]);
  main.rows.push([]);
  main.rows.push(['Venta no trazable (S/)', num(report.untraceableSalesPen)]);

  // Modal desglosado: bobina × tipo, sumando las filas del mismo tipo.
  const byCoilKind = new Map<
    string,
    {
      kind: SalesMaterialKind;
      code: string;
      thicknessMm: string;
      colorLabel: string;
      kg: Decimal;
      cost: Decimal;
    }
  >();
  for (const row of report.rows) {
    for (const coil of row.coils) {
      const key = `${coil.coilId}|${row.kind}`;
      const found = byCoilKind.get(key) ?? {
        kind: row.kind,
        code: coil.code,
        thicknessMm: coil.thicknessMm,
        colorLabel: coil.colorLabel,
        kg: new Decimal(0),
        cost: new Decimal(0),
      };
      found.kg = found.kg.plus(toDecimal(coil.kg));
      found.cost = found.cost.plus(toDecimal(coil.costPen));
      byCoilKind.set(key, found);
    }
  }
  const coils: Sheet = {
    name: 'Bobinas por tipo',
    header: ['Bobina', 'Espesor (mm)', 'Color', 'Tipo', 'Kg consumidos', 'Costo (S/)'],
    widths: [34, 12, 16, 22, 15, 14],
    rows: [...byCoilKind.values()]
      .sort((a, b) => a.code.localeCompare(b.code) || a.kind.localeCompare(b.kind))
      .map((c) => [
        c.code,
        num(c.thicknessMm),
        c.colorLabel,
        SALES_MATERIAL_KIND_LABELS[c.kind],
        num(toFixedString(c.kg, 'KG')),
        num(toFixedString(c.cost, 'MONEY')),
      ]),
  };

  const untraceable: Sheet = {
    name: 'No trazable',
    header: [
      'Comprobante',
      'Emisión',
      'Pedido',
      'SKU',
      'Tipo',
      'Espesor (mm)',
      'Color',
      'Motivo',
      'ML',
      'Venta sin IGV (S/)',
    ],
    widths: [16, 11, 12, 22, 22, 12, 16, 40, 12, 18],
    rows: report.untraceable.map((u) => [
      u.documentNumber ?? '',
      u.issueDate,
      u.orderCode ?? '',
      u.sku,
      SALES_MATERIAL_KIND_LABELS[u.kind],
      num(u.thicknessMm),
      u.colorLabel,
      SALES_MATERIAL_UNTRACEABLE_LABELS[u.reason],
      num(u.metersSold),
      num(u.salesPen),
    ]),
  };

  return {
    buffer: build([main, coils, untraceable]),
    filename: `ventas-por-material-${report.from}-a-${report.to}.xlsx`,
  };
}
