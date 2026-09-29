import type { Prisma } from '@prisma/client';
import { Decimal, piecesMeters, toDecimal } from '@ayr/shared';

interface ReportForMeters {
  metersM: Prisma.Decimal | null;
  piecesDetail: readonly { lengthMm: Prisma.Decimal; qty: number }[];
}

/** Los largos son la fuente de metros de una plancha; MTR usa sus metros ya registrados. */
export function reportMeters(report: ReportForMeters): Decimal | null {
  if (report.metersM !== null) return toDecimal(report.metersM.toString());
  if (report.piecesDetail.length > 0) {
    return piecesMeters(
      report.piecesDetail.map((piece) => ({ lengthMm: piece.lengthMm.toString(), qty: piece.qty })),
    );
  }
  return null;
}

export function sumReportedMeters(reports: readonly ReportForMeters[]): Decimal | null {
  const pieces = reports.flatMap((report) =>
    report.metersM === null
      ? report.piecesDetail.map((piece) => ({
          lengthMm: piece.lengthMm.toString(),
          qty: piece.qty,
        }))
      : [],
  );
  const directMeters = reports.reduce(
    (sum, report) =>
      report.metersM === null ? sum : sum.plus(toDecimal(report.metersM.toString())),
    new Decimal(0),
  );
  if (pieces.length === 0 && !reports.some((report) => report.metersM !== null)) return null;
  return piecesMeters(pieces).plus(directMeters);
}
