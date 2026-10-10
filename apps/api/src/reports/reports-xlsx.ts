import * as XLSX from 'xlsx';
import {
  BUSINESS_LINE_LABELS,
  NO_COST_REPORT_LINES,
  COIL_STATUS_LABELS,
  coilGroupLabel,
  FISCAL_DOC_TYPE_LABELS,
  filterBySearch,
  MARGIN_COST_STATUS_LABELS,
  salesMarginCountLabel,
  salesMarginSearchText,
  searchWords,
  sumDecimal,
  summarizeSalesMargin,
  toDecimal,
  type InventoryValuationDto,
  type InventoryValuationQuery,
  type SalesMarginDto,
  type SalesMarginOrderDto,
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
  // cc40 (D-588): la búsqueda de la pantalla, al pie de las dos hojas que busca.
  notes: (string | number | null)[][] = [],
): {
  buffer: Buffer;
  filename: string;
} {
  const groups: Sheet = {
    name: 'Bobinas por grupo',
    header: ['Línea', 'Espesor (mm)', 'Color', 'Bobinas', 'Saldo (kg)', 'Costo/kg', 'Valor (S/)'],
    widths: [22, 13, 18, 9, 13, 11, 14],
    formats: [null, null, null, null, TWO_DECIMALS, null, null],
    rows: [
      ...report.coilGroups.map((g) => [
        BUSINESS_LINE_LABELS[g.businessLine],
        num(g.thicknessMm),
        coilGroupLabel(g),
        g.coilCount,
        num(g.qtyKg),
        num(g.avgCostPen),
        num(g.totalValuePen),
      ]),
      ...notes,
    ],
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
      // cc39 (D-582): el nombre del acabado, al final para no correr las columnas de siempre.
      'Nombre del acabado',
    ],
    widths: [16, 22, 13, 18, 18, 7, 16, 11, 13, 11, 14, 12, 14, 24],
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
        c.finishName,
      ]),
    ),
  };

  const products: Sheet = {
    name: 'Productos',
    header: ['SKU', 'Descripción', 'Línea', 'Cantidad', 'Unidad', 'Costo unitario', 'Valor (S/)'],
    widths: [18, 40, 22, 12, 9, 15, 14],
    rows: [
      ...report.products.map((p) => [
        p.sku,
        p.name,
        BUSINESS_LINE_LABELS[p.businessLine],
        num(p.qty),
        unitSymbol(p.unit),
        num(p.avgCostPen),
        num(p.totalValuePen),
      ]),
      ...notes,
    ],
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
        line === undefined ? 'Total general' : `Total ${BUSINESS_LINE_LABELS[line]}`,
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
 * M2: los pedidos que suman, sus comprobantes, los que no suman y los totales por línea.
 *
 * Los excluidos van en una hoja aparte y no marcados dentro de la misma, por el mismo motivo
 * que arriba: quien suma la columna de venta de la primera hoja tiene que obtener el total
 * que dice el reporte, y eso solo pasa si lo que no suma no está ahí.
 *
 * cc40 (D-587): **una venta, una fila.** Hasta cc39 los comprobantes colgaban debajo de su pedido
 * en la misma columna «Venta sin IGV», así que sumar la hoja «Por pedido» contaba cada venta dos
 * veces (el pedido y sus comprobantes) y la hoja no tenía total. Ahora «Por pedido» lleva solo
 * los pedidos y una fila de total con el mismo cálculo que el pie de la pantalla
 * (`summarizeSalesMargin`), y los comprobantes van a su propia hoja, cada uno con su pedido.
 *
 * cc39 (D-580): con `line`, el Excel de esa pestaña, del DTO de esa pestaña. Lleva las columnas
 * que la pantalla muestra en ella: sin «Material de OPs» (solo en «Todas»), y en una línea sin
 * costo registrado (Servicios, D-392) sin costo ni margen. Los totales son los de la pestaña.
 *
 * cc40 (D-588): `search` es la búsqueda de la pantalla. Recorta los pedidos que suman, como la
 * tabla; la facturación parcial, el costo no rastreable y la franja no se buscan en la pantalla y
 * tampoco aquí.
 */
export function salesMarginXlsx(
  report: SalesMarginDto,
  line?: SalesMarginQuery['businessLine'],
  search = '',
): { buffer: Buffer; filename: string } {
  const noCost = line !== undefined && NO_COST_REPORT_LINES.includes(line);
  const included = filterBySearch(
    report.orders.filter((o) => o.inTotals),
    salesMarginSearchText,
    search,
  );
  const excludedOrders = report.orders.filter((o) => !o.inTotals);

  // Las columnas de un pedido y, por pestaña, cuáles se quedan.
  const ORDER_COLUMNS = [
    { header: 'Pedido', width: 14 },
    { header: 'Cliente', width: 34 },
    { header: 'Vendedor', width: 20 },
    { header: 'Comprobantes', width: 13 },
    { header: 'Venta sin IGV (S/)', width: 18 },
    { header: 'Costo (S/)', width: 14, cost: true },
    { header: 'Margen (S/)', width: 14, cost: true },
    { header: 'Margen %', width: 10, cost: true },
    { header: 'Material de OPs (S/)', width: 19, allOnly: true },
    // En una línea sin costo (Servicios) el estado del costo lo deciden otras líneas (D-412):
    // la pantalla no lo muestra, y el Excel tampoco.
    { header: 'Costo registrado', width: 18, cost: true },
  ];
  const orderKeep = keepColumns(ORDER_COLUMNS, noCost, line);
  const orderRow = (o: SalesMarginOrderDto): (string | number | null)[] =>
    orderKeep.pick([
      o.orderCode ?? 'Sin pedido',
      o.customerName,
      o.sellerName ?? '',
      o.documents.length,
      num(o.salesPen),
      num(o.costPen),
      num(o.marginPen),
      num(o.marginPct),
      num(o.opMaterialCostPen),
      MARGIN_COST_STATUS_LABELS[o.costStatus],
    ]);
  const summary = summarizeSalesMargin(included);
  const ordersSheet: Sheet = {
    name: 'Por pedido',
    header: orderKeep.header,
    widths: orderKeep.widths,
    rows: [
      ...included.map(orderRow),
      // El pie de la tabla de la pantalla: la venta de cada pedido una vez.
      orderKeep.pick([
        `Total · ${salesMarginCountLabel(summary)}`,
        '',
        '',
        included.reduce((n, o) => n + o.documents.length, 0),
        num(summary.sales.toFixed()),
        num(summary.cost.toFixed()),
        num(summary.margin.toFixed()),
        num(summary.marginPct),
        null,
        '',
      ]),
      ...searchNoteRows(search, included.length, report.orders.filter((o) => o.inTotals).length),
    ],
  };

  const excludedSheet: Sheet = {
    name: 'Facturación parcial',
    header: orderKeep.header,
    widths: orderKeep.widths,
    rows:
      excludedOrders.length === 0
        ? []
        : [
            ...excludedOrders.map(orderRow),
            orderKeep.pick([
              `Total · ${salesMarginCountLabel(summarizeSalesMargin(excludedOrders))}`,
              '',
              '',
              excludedOrders.reduce((n, o) => n + o.documents.length, 0),
              num(summarizeSalesMargin(excludedOrders).sales.toFixed()),
              null,
              null,
              null,
              null,
              '',
            ]),
          ],
  };

  // Los comprobantes, cada uno con su pedido: el detalle que la pantalla abre con la flecha.
  const DOCUMENT_COLUMNS = [
    { header: 'Pedido', width: 14 },
    { header: 'Cliente', width: 34 },
    { header: 'Comprobante', width: 16 },
    { header: 'Tipo', width: 14 },
    { header: 'Emisión', width: 11 },
    { header: 'Venta sin IGV (S/)', width: 18 },
    { header: 'Costo (S/)', width: 14, cost: true },
    { header: 'Margen (S/)', width: 14, cost: true },
    { header: 'Margen %', width: 10, cost: true },
    { header: 'Hoja del pedido', width: 20 },
  ];
  const docKeep = keepColumns(DOCUMENT_COLUMNS, noCost, line);
  const documentRows = (orders: readonly SalesMarginOrderDto[], sheet: string) =>
    orders.flatMap((o) =>
      o.documents.map((d) =>
        docKeep.pick([
          o.orderCode ?? 'Sin pedido',
          o.customerName,
          d.number ?? '',
          FISCAL_DOC_TYPE_LABELS[d.docType],
          d.issueDate,
          num(d.salesPen),
          num(d.costPen),
          num(d.marginPen),
          num(d.marginPct),
          sheet,
        ]),
      ),
    );
  const documentTotal = (orders: readonly SalesMarginOrderDto[], sheet: string) => {
    const docs = orders.flatMap((o) => o.documents);
    return docKeep.pick([
      `Total · ${plural(docs.length, 'comprobante', 'comprobantes')} de «${sheet}»`,
      '',
      '',
      '',
      '',
      num(sumDecimal(docs, (d) => d.salesPen).toFixed()),
      null,
      null,
      null,
      '',
    ]);
  };
  const documentsSheet: Sheet = {
    name: 'Comprobantes',
    header: docKeep.header,
    widths: docKeep.widths,
    rows: [
      ...documentRows(included, 'Por pedido'),
      ...documentRows(excludedOrders, 'Facturación parcial'),
      documentTotal(included, 'Por pedido'),
      ...(excludedOrders.length === 0
        ? []
        : [documentTotal(excludedOrders, 'Facturación parcial')]),
    ],
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
            [],
            // Lo que la ayuda de la pantalla explica: la franja no es el pie de «Por pedido».
            [
              'Estas cifras son las de la franja de la pantalla. La venta incluye la de Servicios de los pedidos de «Facturación parcial» y el margen se calcula sin la venta sin costo registrado, así que pueden no coincidir con el total de «Por pedido», que suma sus filas.',
            ],
          ],
  };

  return {
    buffer: build([ordersSheet, documentsSheet, excludedSheet, totals]),
    filename: `ventas-margen-${report.from}-a-${report.to}${line === undefined ? '' : `-${line}`}.xlsx`,
  };
}

/**
 * Las columnas que se quedan en la pestaña: sin costo en una línea sin costo registrado
 * (Servicios) y sin las de «Todas» en la pestaña de una línea. `pick` toma una fila con todas las
 * columnas y deja las que quedan, por su índice original: quitar columnas no corre nada.
 */
function keepColumns(
  columns: readonly { header: string; width: number; cost?: boolean; allOnly?: boolean }[],
  noCost: boolean,
  line: SalesMarginQuery['businessLine'],
) {
  const keep = columns
    .map((c, i) => ({ ...c, i }))
    .filter((c) => !(c.cost === true && noCost) && !(c.allOnly === true && line !== undefined));
  return {
    header: keep.map((c) => c.header),
    widths: keep.map((c) => c.width),
    pick: (row: (string | number | null)[]): (string | number | null)[] =>
      keep.map((c) => row[c.i] ?? null),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * cc40 (D-588): con la búsqueda de la pantalla, la hoja lo dice al pie, para que nadie tome las
 * filas recortadas por el reporte entero. Sin búsqueda, nada.
 */
export function searchNoteRows(
  search: string,
  shown: number,
  total: number,
): (string | number | null)[][] {
  if (searchWords(search).length === 0) return [];
  return [
    [],
    [
      `Búsqueda «${search.trim()}»: ${String(shown)} de ${String(total)} filas, las mismas que la pantalla. El total suma solo esas filas.`,
    ],
  ];
}
