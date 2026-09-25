import * as XLSX from 'xlsx';
import {
  BUSINESS_LINE_LABELS,
  COIL_STATUS_LABELS,
  coilGroupLabel,
  FISCAL_DOC_TYPE_LABELS,
  type InventoryValuationDto,
  type SalesMarginDto,
} from '@ayr/shared';

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
interface Sheet {
  name: string;
  header: string[];
  rows: (string | number | null)[][];
  widths: number[];
}

/** Monto o cantidad a celda numérica. `null` queda vacío, que no es lo mismo que cero. */
function num(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function build(sheets: Sheet[]): Buffer {
  const book = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const grid = XLSX.utils.aoa_to_sheet([sheet.header, ...sheet.rows]);
    grid['!cols'] = sheet.widths.map((wch) => ({ wch }));
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
 */
export function inventoryValuationXlsx(report: InventoryValuationDto): {
  buffer: Buffer;
  filename: string;
} {
  const groups: Sheet = {
    name: 'Bobinas por grupo',
    header: ['Línea', 'Espesor (mm)', 'Color', 'Bobinas', 'Saldo (kg)', 'Costo/kg', 'Valor (S/)'],
    widths: [22, 13, 18, 9, 13, 11, 14],
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
      p.unit,
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
    filename: `inventario-valorizado-${report.asOf}.xlsx`,
  };
}

/**
 * M2 en tres hojas: los pedidos que suman, los que no, y los totales por línea.
 *
 * Los excluidos van en una hoja aparte y no marcados dentro de la misma, por el mismo motivo
 * que arriba: quien suma la columna de venta de la primera hoja tiene que obtener el total
 * que dice el reporte, y eso solo pasa si lo que no suma no está ahí.
 */
export function salesMarginXlsx(report: SalesMarginDto): { buffer: Buffer; filename: string } {
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
      ]);

  const header = [
    'Pedido',
    'Cliente',
    'Vendedor',
    'Comprobante',
    'Tipo',
    'Venta sin IGV (S/)',
    'Costo (S/)',
    'Margen (S/)',
    'Margen %',
    'Material de OPs (S/)',
    'Costo / Emisión',
  ];
  const widths = [14, 34, 20, 16, 14, 18, 14, 14, 10, 19, 16];

  const included: Sheet = { name: 'Por pedido', header, widths, rows: rowsOf(true) };
  const excluded: Sheet = {
    name: 'Facturación parcial',
    header,
    widths,
    rows: rowsOf(false),
  };

  const totals: Sheet = {
    name: 'Totales',
    header: ['Línea', 'Venta sin IGV (S/)', 'Costo (S/)', 'Margen (S/)', 'Margen %'],
    widths: [30, 18, 14, 14, 10],
    rows: [
      ...report.totalsByLine.map((t) => [
        t.businessLine === null
          ? 'Sin línea (servicios y ajustes)'
          : BUSINESS_LINE_LABELS[t.businessLine],
        num(t.salesPen),
        num(t.costPen),
        num(t.marginPen),
        num(t.marginPct),
      ]),
      [
        'Total del rango',
        num(report.totals.salesPen),
        num(report.totals.costPen),
        num(report.totals.marginPen),
        num(report.totals.marginPct),
      ],
      [],
      ['Pedidos con costo parcial', report.totals.partialOrderCount, null, null, null],
      ['Pedidos fuera de los totales', report.totals.excludedOrderCount, null, null, null],
      ['Venta fuera de los totales', num(report.totals.excludedSalesPen), null, null, null],
      ['Pedidos con costo no rastreable', report.totals.untraceableOrderCount, null, null, null],
      ['Venta con costo no rastreable', num(report.totals.untraceableSalesPen), null, null, null],
    ],
  };

  return {
    buffer: build([included, excluded, totals]),
    filename: `ventas-margen-${report.from}-a-${report.to}.xlsx`,
  };
}

const COST_STATUS_LABELS: Record<SalesMarginDto['orders'][number]['costStatus'], string> = {
  COMPLETO: 'Completo',
  PARCIAL: 'Costo parcial',
  NO_COMPARABLE: 'No comparable',
  NO_RASTREABLE: 'Costo no rastreable',
};
