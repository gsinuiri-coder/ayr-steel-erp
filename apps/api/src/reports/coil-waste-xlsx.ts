import {
  BUSINESS_LINE_LABELS,
  BusinessLine,
  COIL_STATUS_LABELS,
  MISSING_THEORETICAL_LABELS,
  type CoilWasteDto,
} from '@ayr/shared';
import { build, num, TWO_DECIMALS, type Sheet } from './reports-xlsx';

/**
 * cc39 (D-580) — «Merma por bobina» en xlsx, del mismo DTO que la pantalla y su pestaña
 * (Coberturas Aluzinc o Drywall). Dos hojas: una fila por bobina con las columnas de la tabla y
 * el total del reporte al pie, y sus producciones del rango (el detalle que la pantalla abre con
 * la flecha), cada una en su fila para poder ordenar y filtrar.
 *
 * El total es el del API (`totals`), el mismo que la pantalla muestra al pie sin búsqueda: el
 * teórico, la diferencia y la merma solo de las bobinas con teórico completo (D-425), así que esas
 * tres columnas no suman las filas cuando hay bobinas sin teórico; la fila lo dice.
 */
export function coilWasteXlsx(
  report: CoilWasteDto,
  // cc40 (D-588): la búsqueda de la pantalla, al pie de la hoja de bobinas.
  notes: (string | number | null)[][] = [],
): { buffer: Buffer; filename: string } {
  // En Drywall, lo que sale al cerrar la OP es la merma de proceso (D-057), no un despunte.
  const trimLabel =
    report.businessLine === BusinessLine.DRYWALL ? 'Merma de proceso (kg)' : 'Despunte (kg)';
  const t = report.totals;
  const partial = t.comparableCoilCount < t.coilCount;

  const coils: Sheet = {
    name: 'Merma por bobina',
    header: [
      'Bobina',
      'Tipo',
      'Acabado',
      'Color',
      'Ancho (mm)',
      'Estado',
      'Consumido (kg)',
      'Teórico (kg)',
      'Diferencia (kg)',
      trimLabel,
      'Ajuste de cierre (kg)',
      'Merma (kg)',
      'Merma %',
      'Fuera de tolerancia (merma %)',
      'Otra merma (kg)',
    ],
    widths: [30, 18, 22, 16, 11, 12, 15, 13, 15, 20, 19, 12, 10, 18, 15],
    formats: [
      null,
      null,
      null,
      null,
      null,
      null,
      TWO_DECIMALS,
      TWO_DECIMALS,
      TWO_DECIMALS,
      TWO_DECIMALS,
      TWO_DECIMALS,
      TWO_DECIMALS,
      null,
      null,
      TWO_DECIMALS,
    ],
    rows: [
      ...report.rows.map((r) => [
        r.code,
        r.typeKey,
        r.finishName,
        r.colorName ?? '',
        num(r.widthMm),
        COIL_STATUS_LABELS[r.status],
        num(r.consumedKg),
        num(r.theoreticalKg),
        num(r.differenceKg),
        num(r.trimKg),
        num(r.closeAdjustmentKg),
        num(r.wasteKg),
        num(r.wastePct),
        r.wastePct === null ? '' : r.overStandard ? 'Sí' : 'No',
        num(r.manualScrapKg),
      ]),
      [
        `Total · ${String(t.coilCount)} ${t.coilCount === 1 ? 'bobina' : 'bobinas'}`,
        '',
        '',
        '',
        null,
        '',
        num(t.consumedKg),
        num(t.theoreticalKg),
        num(t.differenceKg),
        num(t.trimKg),
        num(t.closeAdjustmentKg),
        num(t.wasteKg),
        num(t.wastePct),
        t.wastePct === null ? '' : t.overStandard ? 'Sí' : 'No',
        num(t.manualScrapKg),
      ],
      ...notes,
      ...(partial
        ? [
            [],
            [
              `Teórico, diferencia y merma: ${String(t.comparableCoilCount)} de ${String(t.coilCount)} bobinas (las de teórico completo), que consumieron (kg)`,
              num(t.comparableConsumedKg),
            ],
          ]
        : []),
      [],
      [
        `${BUSINESS_LINE_LABELS[report.businessLine]}, del ${report.from} al ${report.to}. Merma = (consumido − teórico) + ${trimLabel.replace(' (kg)', '').toLowerCase()} + ajuste de cierre. El teórico ya incluye el 1 % estándar; normal hasta el ${report.standardPct} % sobre el estándar. «Otra merma» es informativa y no suma.`,
      ],
    ],
  };

  const productions: Sheet = {
    name: 'Producciones',
    header: [
      'Bobina',
      'Orden',
      'Fecha',
      'Consumido (kg)',
      'Teórico (kg)',
      'Fuera de tolerancia',
      'Exceso %',
      'Sin teórico atribuible',
    ],
    widths: [30, 14, 11, 15, 13, 40, 10, 50],
    formats: [null, null, null, TWO_DECIMALS, TWO_DECIMALS, null, null, null],
    rows: report.rows.flatMap((r) =>
      r.productions.map((p) => [
        r.code,
        p.productionOrderCode ?? 'Sin orden',
        p.operationDate,
        num(p.consumedKg),
        num(p.theoreticalKg),
        p.outOfTolerance?.label ?? '',
        p.outOfTolerance === null ? null : num(p.outOfTolerance.excessPct),
        p.missingTheoretical === null ? '' : MISSING_THEORETICAL_LABELS[p.missingTheoretical],
      ]),
    ),
  };

  return {
    buffer: build([coils, productions]),
    filename: `merma-por-bobina-${report.from}-a-${report.to}-${report.businessLine}.xlsx`,
  };
}
