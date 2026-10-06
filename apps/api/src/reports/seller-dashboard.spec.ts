import { assembleSellerDashboard } from './seller-dashboard';

/** cc27 (M4, D-457). Lo único que el Panel del vendedor hace con lo que lee. */
describe('assembleSellerDashboard', () => {
  const month = { from: '2026-10-01', to: '2026-10-06' };

  it('suma las facturas y boletas y resta las notas de crédito, sin IGV', () => {
    const dto = assembleSellerDashboard({
      month,
      sales: [
        { docType: 'FACTURA', count: 2, subtotalPen: '1500.0000' },
        { docType: 'BOLETA', count: 1, subtotalPen: '50.5000' },
        { docType: 'NOTA_CREDITO', count: 1, subtotalPen: '200.0000' },
      ],
      quotationsIssued: 4,
      quotationsConverted: 1,
    });
    expect(dto).toEqual({
      month,
      salesPen: '1350.5000',
      documentCount: 4,
      quotationsIssued: 4,
      quotationsConverted: 1,
      conversionPct: '25.0',
    });
  });

  it('sin cotizaciones en el mes no hay porcentaje; sin ventas, cero', () => {
    const dto = assembleSellerDashboard({
      month,
      sales: [],
      quotationsIssued: 0,
      quotationsConverted: 0,
    });
    expect(dto.salesPen).toBe('0.0000');
    expect(dto.documentCount).toBe(0);
    expect(dto.conversionPct).toBeNull();
  });

  it('redondea la conversión a un decimal, al medio hacia arriba', () => {
    const dto = assembleSellerDashboard({
      month,
      sales: [{ docType: 'FACTURA', count: 1, subtotalPen: null }],
      quotationsIssued: 3,
      quotationsConverted: 2,
    });
    expect(dto.conversionPct).toBe('66.7');
    expect(dto.salesPen).toBe('0.0000');
  });
});
