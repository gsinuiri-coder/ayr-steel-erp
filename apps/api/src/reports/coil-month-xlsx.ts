import {
  BUSINESS_LINE_LABELS,
  coilStateLabel,
  CoilFilmState,
  type CoilMonthReportDto,
  type CoilMonthReportSectionDto,
} from '@ayr/shared';
import { build, num, type Sheet } from './reports-xlsx';

/**
 * D-355 — el reporte mensual de bobinas en xlsx, del mismo DTO que la pantalla: una hoja por
 * tabla («Selladas», «Abiertas», solo las vigentes al último día del mes) y una hoja «Resumen»
 * con los totales, las líneas de lo no listado y el cuadre inicio + altas − salidas = cierre.
 * El valor y el costo por kg solo viajan si el rol los ve (mismo enmascarado que la pantalla).
 *
 * cc40 (D-588): `notes` son las filas que dicen la búsqueda de la pantalla (`searchNoteRows`),
 * al pie de la hoja principal; el DTO ya llega recortado (`report-xlsx-search.ts`).
 */
export function coilMonthXlsx(
  report: CoilMonthReportDto,
  notes: (string | number | null)[][] = [],
): { buffer: Buffer; filename: string } {
  const showsCost = report.totals.closingValuePen !== null;
  const header = [
    'Código',
    'Tipo',
    'Línea',
    'Color',
    'Ancho (mm)',
    'Saldo inicio mes (kg)',
    'Peso (kg)',
    'Saldo fin de mes (kg)',
    ...(showsCost ? ['Costo/kg (S/)', 'Valor fin de mes (S/)'] : []),
    'Estado',
  ];
  const widths = [34, 22, 20, 14, 11, 20, 12, 20, ...(showsCost ? [13, 20] : []), 12];

  const section = (name: string, film: CoilFilmState, s: CoilMonthReportSectionDto): Sheet => ({
    name,
    header,
    widths,
    rows: [
      ...s.rows.map((r) => [
        r.code,
        r.typeKey,
        BUSINESS_LINE_LABELS[r.businessLine],
        r.colorName ?? '',
        num(r.widthMm),
        num(r.openingKg),
        num(r.weightKg),
        num(r.closingKg),
        ...(showsCost ? [num(r.unitCostPerKg), num(r.closingValuePen)] : []),
        coilStateLabel({ status: r.status, film }),
      ]),
      [
        `Subtotal ${name}`,
        '',
        '',
        '',
        null,
        num(s.totals.openingKg),
        num(s.totals.weightKg),
        num(s.totals.closingKg),
        ...(showsCost ? [null, num(s.totals.closingValuePen)] : []),
        '',
      ],
      ...notes,
    ],
  });

  const summary: Sheet = {
    name: 'Resumen',
    header: ['Concepto', 'Cantidad', 'Kg'],
    widths: [52, 10, 16],
    rows: [
      ...(report.businessLine === null
        ? []
        : [[`Línea: ${BUSINESS_LINE_LABELS[report.businessLine]}`, null, null], []]),
      ['Saldo inicio de mes', null, num(report.flow.openingKg)],
      ['Altas del mes', null, num(report.flow.entriesKg)],
      ['Salidas del mes', null, num(report.flow.exitsKg)],
      ['Saldo fin de mes', null, num(report.flow.closingKg)],
      [],
      [
        'Bobinas terminadas o agotadas en el mes, no listadas (kg consumidos)',
        report.finished.count,
        num(report.finished.consumedKg),
      ],
      [
        'Anuladas en el mes con saldo al inicio (saldo al inicio)',
        report.annulledWithOpening.count,
        num(report.annulledWithOpening.openingKg),
      ],
      ...(showsCost
        ? [[], ['Valor fin de mes (S/)', null, num(report.totals.closingValuePen)]]
        : []),
    ],
  };

  return {
    buffer: build([
      section('Selladas', CoilFilmState.SEALED, report.sealed),
      section('Abiertas', CoilFilmState.OPENED, report.opened),
      summary,
    ]),
    // cc24 (D-408, D-418): el Excel sigue la pestaña; la línea va en el nombre y en el resumen.
    filename: `reporte-bobinas-${report.month}${report.businessLine === null ? '' : `-${report.businessLine}`}.xlsx`,
  };
}
