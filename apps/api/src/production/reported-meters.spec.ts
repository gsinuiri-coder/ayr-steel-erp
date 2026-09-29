import { Decimal } from '@ayr/shared';
import { reportMeters, sumReportedMeters } from './reported-meters';

describe('metros derivados de reportes de producción', () => {
  it('suma dos reportes de plancha desde sus largos, aunque meters_m sea null', () => {
    const reports = [
      { metersM: null, piecesDetail: [{ lengthMm: new Decimal('6000.00'), qty: 2 }] },
      { metersM: null, piecesDetail: [{ lengthMm: new Decimal('3500.00'), qty: 3 }] },
    ];

    expect(sumReportedMeters(reports)?.toFixed(3)).toBe('22.500');
  });

  it('redondea el total de varios reportes una sola vez, igual que planta', () => {
    const reports = [
      { metersM: null, piecesDetail: [{ lengthMm: new Decimal('1000.49'), qty: 1 }] },
      { metersM: null, piecesDetail: [{ lengthMm: new Decimal('1000.49'), qty: 1 }] },
    ];
    expect(sumReportedMeters(reports)?.toFixed(3)).toBe('2.001');
  });

  it('conserva los metros registrados cuando el reporte MTR también lleva largos', () => {
    expect(
      reportMeters({
        metersM: new Decimal('99.000'),
        piecesDetail: [{ lengthMm: new Decimal('2500.00'), qty: 2 }],
      })?.toFixed(3),
    ).toBe('99.000');
  });

  it('suma los metros MTR ya redondeados por reporte', () => {
    expect(
      sumReportedMeters([
        {
          metersM: new Decimal('1.000'),
          piecesDetail: [{ lengthMm: new Decimal('1000.49'), qty: 1 }],
        },
        {
          metersM: new Decimal('1.000'),
          piecesDetail: [{ lengthMm: new Decimal('1000.49'), qty: 1 }],
        },
      ])?.toFixed(3),
    ).toBe('2.000');
  });

  it('conserva los metros directos de un accesorio y null para drywall', () => {
    expect(reportMeters({ metersM: new Decimal('7.250'), piecesDetail: [] })?.toFixed(3)).toBe(
      '7.250',
    );
    expect(sumReportedMeters([{ metersM: null, piecesDetail: [] }])).toBeNull();
  });
});
