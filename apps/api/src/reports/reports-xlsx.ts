import * as XLSX from 'xlsx';
import {
  BUSINESS_LINE_LABELS,
  NO_COST_REPORT_LINES,
  COIL_STATUS_LABELS,
  coilGroupLabel,
  FISCAL_DOC_TYPE_LABELS,
  toDecimal,
  type InventoryValuationDto,
  type InventoryValuationQuery,
  type SalesMarginDto,
  type SalesMarginQuery,
} from '@ayr/shared';
import { unitSymbol } from '../common/unit-symbol';

/**
 * RF-S4a/M3 — los dos reportes en xlsx.
 *
 * **Los montos van como número, no como texto.** Todo el dominio los mueve como string con
 * su escala (`Decimal`, D-003) y esa es la forma correcta de transportarlos sin que un
 * `double` les coma un centavo por el camino; pero un xlsx cuyo total llega como texto no se
 * puede sumar en la hoja, que es lo único que alguien hace con este archivo apenas lo abre.
 * La conversión ocurre **acá y en ningún otro lado**, en el último paso antes de escribir la
 * celda, y sobre un valor que ya está redondeado a su escala: el `Number` no decide nada, solo
 * transporta lo que el servicio ya calculó.
 *
 * Los estados y las líneas van con su etiqueta en español, la misma que muestra la pantalla:
 * el archivo lo abre una persona, no un parser.
 */

/** Una hoja: encabezados, filas y anchos de columna. */
export interface Sheet {
  name: string;
  header: string[];
  rows: (string | number | null)[][];
  widths: number[];
  /**
   * cc39 (D-585): el formato de número de cada columna, solo para mostrar (`null` deja el
   * General). La celda guarda el valor completo, así que la suma de la hoja da el total del
   * reporte; el formato solo decide cuántos decimales se ven.
   */
  formats?: (string | null)[];
}

/** cc39 (D-585): metros y kilos con dos decimales a la vista, como en las listas. */
export const TWO_DECIMALS = '#,##0.00';

/** Monto o cantidad a celda numérica. `null` queda vacío, que no es lo mismo que cero. */
export function num(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function build(sheets: Sheet[]): Buffer {
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const grid = XLSX.utils.aoa_to_sheet([sheet.header, ...sheet.rows]);
    grid['!cols'] = sheet.widths.map((wch) => ({ wch }));
    sheet.formats?.forEach((format, c) => {
      if (format === null) return;
      for (let r = 1; r <= sheet.rows.length; r += 1) {
        const cell = grid[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
        if (cell?.t === 'n') cell.z = format;
      }
    });
    // Congelar la fila de encabezados: estas hojas se leen bajando cientos de filas.
    grid['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(book, grid, sheet.name);
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * M1 en tres hojas. El detalle por bobina va **en su propia hoja** y no indentado bajo su
 * grupo: una hoja con filas de dos naturalezas distintas no se puede ordenar ni filtrar sin
 * romperla, y ordenar y filtrar es exactamente para lo que alguien exporta esto.
 *
 * cc39 (D-580): con `line`, el Excel de esa pestaña. El DTO ya viene filtrado por la línea, así
 * que las hojas son las mismas con las filas de la pestaña, y el nombre del archivo la lleva.
 */
export function inventoryValuationXlsx(
  report: InventoryValuationDto,
  line?: InventoryValuationQuery['businessLine'],
): {
  buffer: Buffer;
  filename: string;
} {
  const groups: Sheet = {
    name: 'Bobinas por grupo',
    header: ['Línea', 'Espesor (mm)', 'Color', 'Bobinas', 'Saldo (kg)', 'Costo/kg', 'Valor (S/)'],
    widths: [22, 13, 18, 9, 13, 11, 14],
    formats: [null, null, null, null, TWO_DECIMALS, null, null],
    rows: report.coilGroups.map((g) => [
      BUSINESS_LINE_LABELS[g.businessLine],
      num(g.thicknessMm),
      coilGroupLabel(g),
      g.coilCount,
      num(g.qtyKg),
      num(g.avgCostPen),
      num(g.totalValuePen),
    ]),
  };

  const coils: Sheet = {
    name: 'Bobinas',
    header: [
      'Código',
      'Línea',
      'Espesor (mm)',
      'Color',
      'Acabado',
      'RAL',
      'Tipo',
      'Ancho (mm)',
      'Saldo (kg)',
      'Costo/kg',
      'Valor (S/)',
      'Estado',
      'Fecha de alta',
    ],
    widths: [16, 22, 13, 18, 18, 7, 16, 11, 13, 11, 14, 12, 14],
    formats: [null, null, null, null, null, null, null, null, TWO_DECIMALS],
    rows: report.coilGroups.flatMap((g) =>
      g.coils.map((c) => [
        c.code,
        BUSINESS_LINE_LABELS[g.businessLine],
        num(g.thicknessMm),
        coilGroupLabel(g),
        // D-272: el acabado es donde vive el RAL (D-270).
        c.finishCode,
        c.ral ?? '',
        c.typeKey,
        num(c.widthMm),
        num(c.qtyKg),
        num(c.avgCostPen),
        num(c.totalValuePen),
        COIL_STATUS_LABELS[c.status],
        c.operationDate,
      ]),
    ),
  };

  const products: Sheet = {
    name: 'Productos',
    header: ['SKU', 'Descripción', 'Línea', 'Cantidad', 'Unidad', 'Costo unitario', 'Valor (S/)'],
    widths: [18, 40, 22, 12, 9, 15, 14],
    rows: report.products.map((p) => [
      p.sku,
      p.name,
      BUSINESS_LINE_LABELS[p.businessLine],
      num(p.qty),
      unitSymbol(p.unit),
      num(p.avgCostPen),
      num(p.totalValuePen),
    ]),
  };

  const totals: Sheet = {
    name: 'Totales',
    header: ['Línea', 'Bobinas (S/)', 'Productos (S/)', 'Total (S/)'],
    widths: [24, 15, 16, 15],
    rows: [
      ...report.totalsByLine.map((t) => [
        BUSINESS_LINE_LABELS[t.businessLine],
        num(t.coilValuePen),
        num(t.productValuePen),
        num(t.totalValuePen),
      ]),
      [
        'Total general',
        num(report.totals.coilValuePen),
        num(report.totals.productValuePen),
        num(report.totals.totalValuePen),
      ],
    ],
  };

  return {
    buffer: build([groups, coils, products, totals]),
    filename: `inventario-valorizado-${report.asOf}${line === undefined ? '' : `-${line}`}.xlsx`,
  };
}

/**
 * M2 en tres hojas: los pedidos que suman, los que no, y los totales por línea.
 *
 * Los excluidos van en una hoja aparte y no marcados dentro de la misma, por el mismo motivo
 * que arriba: quien suma la columna de venta de la primera hoja tiene que obtener el total
 * que dice el reporte, y eso solo pasa si lo que no suma no está ahí.
 *
 * cc39 (D-580): con `line`, el Excel de esa pestaña, del DTO de esa pestaña. Lleva las columnas
 * que la pantalla muestra en ella: sin «Material de OPs» (solo en «Todas»), y en una línea sin
 * costo registrado (Servicios, D-392) sin costo ni margen. Los totales son los de la pestaña.
 */
export function salesMarginXlsx(
  report: SalesMarginDto,
  line?: SalesMarginQuery['businessLine'],
): { buffer: Buffer; filename: string } {
  const noCost = line !== undefined && NO_COST_REPORT_LINES.includes(line);
  // Las once columnas de siempre y, por pestaña, cuáles se quedan.
  const COLUMNS = [
    { header: 'Pedido', width: 14 },
    { header: 'Cliente', width: 34 },
    { header: 'Vendedor', width: 20 },
    { header: 'Comprobante', width: 16 },
    { header: 'Tipo', width: 14 },
    { header: 'Venta sin IGV (S/)', width: 18 },
    { header: 'Costo (S/)', width: 14, cost: true },
    { header: 'Margen (S/)', width: 14, cost: true },
    { header: 'Margen %', width: 10, cost: true },
    { header: 'Material de OPs (S/)', width: 19, allOnly: true },
    { header: 'Costo / Emisión', width: 16 },
  ];
  const keep = COLUMNS.map((c, i) => ({ ...c, i })).filter(
    (c) => !(c.cost === true && noCost) && !(c.allOnly === true && line !== undefined),
  );
  const pick = (row: (string | number | null)[]): (string | number | null)[] =>
    keep.map((c) => row[c.i] ?? null);

  const rowsOf = (inTotals: boolean): (string | number | null)[][] =>
    report.orders
      .filter((o) => o.inTotals === inTotals)
      .flatMap((o) => [
        [
          o.orderCode ?? 'Sin pedido',
          o.customerName,
          o.sellerName ?? '',
          '',
          '',
          num(o.salesPen),
          num(o.costPen),
          num(o.marginPen),
          num(o.marginPct),
          num(o.opMaterialCostPen),
          COST_STATUS_LABELS[o.costStatus],
        ],
        // Los comprobantes cuelgan debajo con el pedido en blanco: el archivo se lee de
        // arriba abajo y repetir el código en cada línea lo vuelve ilegible.
        ...o.documents.map((d) => [
          '',
          '',
          '',
          d.number ?? '',
          FISCAL_DOC_TYPE_LABELS[d.docType],
          num(d.salesPen),
          num(d.costPen),
          num(d.marginPen),
          num(d.marginPct),
          null,
          d.issueDate,
        ]),
      ])
      .map(pick);

  const header = keep.map((c) => c.header);
  const widths = keep.map((c) => c.width);

  const included: Sheet = { name: 'Por pedido', header, widths, rows: rowsOf(true) };
  const excluded: Sheet = {
    name: 'Facturación parcial',
    header,
    widths,
    rows: rowsOf(false),
  };

  const stats: (string | number | null)[][] = [
    [],
    ['Pedidos con costo parcial', report.totals.partialOrderCount, null, null, null],
    ['Pedidos fuera de los totales', report.totals.excludedOrderCount, null, null, null],
    ['Venta fuera de los totales', num(report.totals.excludedSalesPen), null, null, null],
    ['Pedidos con costo no rastreable', report.totals.untraceableOrderCount, null, null, null],
    ['Venta con costo no rastreable', num(report.totals.untraceableSalesPen), null, null, null],
  ];

  const totals: Sheet = {
    name: 'Totales',
    header: ['Línea', 'Venta sin IGV (S/)', 'Costo (S/)', 'Margen (S/)', 'Margen %'],
    widths: [30, 18, 14, 14, 10],
    rows:
      line !== undefined
        ? [
            // La pestaña de una línea: sus cifras, las mismas de la franja de la pantalla. En
            // Servicios, solo la venta, sin un costo 0 con margen del 100 % (D-392).
            noCost
              ? [
                  `Total ${BUSINESS_LINE_LABELS[line]} (sin costo registrado)`,
                  num(report.totals.salesPen),
                  null,
                  null,
                  null,
                ]
              : [
                  `Total ${BUSINESS_LINE_LABELS[line]}`,
                  num(report.totals.salesPen),
                  num(report.totals.costPen),
                  num(report.totals.marginPen),
                  num(report.totals.marginPct),
                ],
            ...stats,
          ]
        : [
            ...report.totalsByLine.map((t) => {
              const label =
                t.businessLine === null
                  ? 'Sin línea (servicios y ajustes)'
                  : BUSINESS_LINE_LABELS[t.businessLine];
              // D-392/D-409/D-419: Servicios y «Sin línea» no tienen costo registrado y quedan fuera del margen; su fila
              // no muestra un costo 0 con margen del 100 %, igual que en la pantalla.
              return t.businessLine === null || NO_COST_REPORT_LINES.includes(t.businessLine)
                ? [label, num(t.salesPen), null, null, null]
                : [label, num(t.salesPen), num(t.costPen), num(t.marginPen), num(t.marginPct)];
            }),
            // cc28 (D-461): la misma fila que la pantalla, para que la columna sume el total.
            ...(toDecimal(report.totals.roundingPen).isZero()
              ? []
              : [
                  [
                    'Redondeo al céntimo de los comprobantes',
                    num(report.totals.roundingPen),
                    null,
                    null,
                    null,
                  ],
                ]),
            [
              'Total del rango (margen sin Servicios ni líneas sin producto)',
              num(report.totals.salesPen),
              num(report.totals.costPen),
              num(report.totals.marginPen),
              num(report.totals.marginPct),
            ],
            [
              'Sin costo registrado (Servicios y líneas sin producto), fuera del margen',
              num(report.totals.noCostSalesPen),
              null,
              null,
              null,
            ],
            ...stats,
          ],
  };

  return {
    buffer: build([included, excluded, totals]),
    filename: `ventas-margen-${report.from}-a-${report.to}${line === undefined ? '' : `-${line}`}.xlsx`,
  };
}

const COST_STATUS_LABELS: Record<SalesMarginDto['orders'][number]['costStatus'], string> = {
  COMPLETO: 'Completo',
  PARCIAL: 'Costo parcial',
  NO_COMPARABLE: 'No comparable',
  NO_RASTREABLE: 'Costo no rastreable',
};
