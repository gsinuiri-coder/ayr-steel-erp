import {
  BUSINESS_LINE_LABELS,
  BusinessLine,
  Decimal,
  SALES_MATERIAL_KIND_LABELS,
  SALES_PRODUCT_UNTRACEABLE_LABELS,
  toDecimal,
  toFixedString,
  SALES_MATERIAL_UNTRACEABLE_LABELS,
  type SalesByMaterialDto,
  type SalesByMaterialLine,
  type SalesByProductDto,
  type SalesMaterialFiguresDto,
  type SalesMaterialKind,
} from '@ayr/shared';
import { unitSymbol } from '../common/unit-symbol';
import { build, num, TWO_DECIMALS, type Sheet } from './reports-xlsx';

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
  'Precio/ML venta (S/)',
  'Costo/ML (S/)',
  'Ganancia/ML (S/)',
  'Cantidad vendida',
  'Unidad',
  'Costo prom./unidad (S/)',
];

/** C06: un cociente sin divisor (cantidad o ML en 0) va como «—», nunca 0 ni vacío. */
const DASH = '—';
const orDash = (value: string | null): number | string => num(value) ?? DASH;

function figureCells(f: SalesMaterialFiguresDto): (number | string | null)[] {
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
    orDash(f.pricePerMeterPen),
    orDash(f.costPerMeterPen),
    orDash(f.marginPerMeterPen),
    orDash(f.qty),
    f.unit === null ? DASH : unitSymbol(f.unit),
    orDash(f.costPerUnitPen),
  ];
}

/** Las columnas de `FIGURE_HEADER` que son metros o kilos (ML, teórico, real, rendimiento). */
const FIGURE_FORMATS = [TWO_DECIMALS, TWO_DECIMALS, TWO_DECIMALS, TWO_DECIMALS];

/** cc39: lo que el cuadre deja fuera de las filas, según la línea (D-354, D-414), como la pantalla. */
const UNCLASSIFIED_LABEL: Partial<Record<SalesByMaterialLine, string>> = {
  [BusinessLine.METALLIC_ROOFING]: 'Productos de la línea sin subtipo',
  [BusinessLine.DRYWALL]: 'Productos comprados de Drywall (sin bobina)',
};

/**
 * El cuadre con «Ventas y margen», sin filtros (D-354, D-407, D-413), con las cifras de la
 * leyenda de la pantalla. Solo agrega una fila cuando su cifra no es cero, salvo la venta de la
 * línea, que va siempre.
 */
function reconciliationRows(report: SalesByMaterialDto): (string | number | null)[][] {
  const line = report.businessLine;
  const label = BUSINESS_LINE_LABELS[line];
  const { lineSalesPen, coilSalesPen, unclassifiedSalesPen } = report.reconciliation;
  const rows: (string | number | null)[][] = [
    [`Venta de ${label} facturada en el rango (S/)`, num(lineSalesPen)],
  ];
  if (line === BusinessLine.TRADING) {
    // D-413: la bobina entera vive en la pestaña de la línea de su bobina.
    rows.push([
      'De ella, bobinas enteras de Coberturas Aluzinc o Drywall, en esas pestañas (S/)',
      num(coilSalesPen),
    ]);
  } else if (line !== BusinessLine.ROOFING) {
    rows.push([`Venta de bobinas enteras de ${label} (S/)`, num(coilSalesPen)]);
  }
  const unclassified = UNCLASSIFIED_LABEL[line];
  if (unclassified !== undefined && !toDecimal(unclassifiedSalesPen).isZero()) {
    rows.push([`${unclassified}, fuera de las filas (S/)`, num(unclassifiedSalesPen)]);
  }
  // D-407: lo que no tiene línea de negocio no entra en ninguna pestaña.
  if (!toDecimal(report.noLineSalesPen).isZero()) {
    rows.push([
      'Venta sin línea de negocio en el periodo, en ninguna pestaña (S/)',
      num(report.noLineSalesPen),
    ]);
  }
  return rows;
}

/**
 * cc39 (D-580): todas las pestañas. Coberturas Aluzinc y Drywall van por material (las tres hojas
 * de siempre); Coberturas (UPVC) y Reventa, por producto (D-417), con sus filas y su no trazable.
 * El nombre del archivo lleva la línea fuera de Coberturas Aluzinc, que conserva el de siempre.
 */
export function salesByMaterialXlsx(report: SalesByMaterialDto): {
  buffer: Buffer;
  filename: string;
} {
  const suffix =
    report.businessLine === BusinessLine.METALLIC_ROOFING ? '' : `-${report.businessLine}`;
  const filename = `ventas-por-material-${report.from}-a-${report.to}${suffix}.xlsx`;
  const sheets =
    report.products === null ? materialSheets(report) : productSheets(report, report.products);
  return { buffer: build(sheets), filename };
}

function materialSheets(report: SalesByMaterialDto): Sheet[] {
  const main: Sheet = {
    name: 'Ventas por material',
    header: ['Tipo', 'Espesor (mm)', 'Color', ...FIGURE_HEADER],
    widths: [22, 12, 16, 12, 16, 14, 15, 13, 17, 21, 14, 18, 18, 14, 18, 14, 16, 16, 8, 20],
    formats: [null, null, null, ...FIGURE_FORMATS],
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
  // El cuadre por comprobante, sin filtros (ver la leyenda de la pantalla).
  main.rows.push(...reconciliationRows(report));

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
    formats: [null, null, null, null, TWO_DECIMALS, null],
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
    formats: [null, null, null, null, null, null, null, null, TWO_DECIMALS, null],
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

  return [main, coils, untraceable];
}

/**
 * cc39 (D-580, D-417): Coberturas (UPVC) y Reventa, por producto. Las columnas de la tabla de la
 * pantalla, con la unidad en su propia columna («und» sin decimales, D-579), y el total del API
 * al pie, el mismo que la pantalla muestra sin búsqueda.
 */
function productSheets(report: SalesByMaterialDto, products: SalesByProductDto): Sheet[] {
  const main: Sheet = {
    name: 'Ventas por producto',
    header: [
      'SKU',
      'Producto',
      'Cantidad',
      'Unidad',
      'Venta sin IGV (S/)',
      'Costo (S/)',
      'Utilidad (S/)',
      'Costo prom./unidad (S/)',
      'Líneas',
    ],
    widths: [20, 40, 12, 8, 18, 14, 14, 22, 8],
    rows: [
      ...products.rows.map((r) => [
        r.sku,
        r.name,
        num(r.qty),
        unitSymbol(r.unit),
        num(r.salesPen),
        num(r.costPen),
        num(r.profitPen),
        orDash(r.costPerUnitPen),
        r.lineCount,
      ]),
      [
        'Total',
        '',
        null,
        '',
        num(products.total.salesPen),
        num(products.total.costPen),
        num(products.total.profitPen),
        null,
        null,
      ],
      [],
      ['Venta no trazable (S/)', num(report.untraceableSalesPen)],
      ...reconciliationRows(report),
    ],
  };

  const untraceable: Sheet = {
    name: 'No trazable',
    header: [
      'Comprobante',
      'Emisión',
      'Pedido',
      'SKU',
      'Motivo',
      'Cantidad',
      'Unidad',
      'Venta sin IGV (S/)',
    ],
    widths: [16, 11, 12, 22, 40, 12, 8, 18],
    rows: products.untraceable.map((u) => [
      u.documentNumber ?? '',
      u.issueDate,
      u.orderCode ?? '',
      u.sku,
      SALES_PRODUCT_UNTRACEABLE_LABELS[u.reason],
      num(u.qty),
      unitSymbol(u.unit),
      num(u.salesPen),
    ]),
  };

  return [main, untraceable];
}
