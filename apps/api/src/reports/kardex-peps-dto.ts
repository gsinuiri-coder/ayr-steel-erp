import type { KardexPepsReportDto } from '@ayr/shared';
import type { KardexPepsReport } from './kardex-peps.service';

/**
 * D-296: el reporte PEPS del servicio (D-279) como JSON para la pantalla. Es el **mismo mapeo
 * fila por fila que `kardexPepsXlsx`** —documento y operación por movimiento, y la columna
 * «Observación» con la nota del movimiento y la advertencia del cálculo—, sin recalcular nada:
 * lo que se ve en pantalla y lo que baja al Excel no pueden discrepar.
 */
export function kardexPepsToDto(report: KardexPepsReport): KardexPepsReportDto {
  const { peps } = report;
  return {
    from: report.from,
    to: report.to,
    itemCode: report.itemCode,
    itemDescription: report.itemDescription,
    unitCode: report.unitCode,
    opening: peps.opening,
    rows: peps.rows.map((row) => {
      const doc = report.documents.get(row.movementId);
      const observation = [doc?.note, row.warning].filter(Boolean).join(' · ');
      return {
        movementId: row.movementId,
        operationDate: row.operationDate,
        docTypeCode: doc?.docTypeCode ?? '00',
        series: doc?.series ?? '',
        number: doc?.number ?? '',
        operationCode: doc?.operationCode ?? '99',
        operationLabel: doc?.operationLabel ?? 'OTROS',
        inQty: row.inQty,
        inUnitCost: row.inUnitCost,
        inTotal: row.inTotal,
        outQty: row.outQty,
        outUnitCost: row.outUnitCost,
        outTotal: row.outTotal,
        balanceQty: row.balanceQty,
        balanceUnitCost: row.balanceUnitCost,
        balanceTotal: row.balanceTotal,
        observation: observation || null,
      };
    }),
    closing: peps.closing,
    totals: peps.totals,
    warnings: peps.warnings,
  };
}
