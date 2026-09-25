import { kardexPepsToDto } from './kardex-peps-dto';
import type { KardexPepsReport } from './kardex-peps.service';

// D-296: el JSON de la pantalla es el mismo reporte que el Excel del formato 13.1.
const balance = { qty: '0.000', unitCost: '0.0000', total: '0.0000', layers: [] };

function report(): KardexPepsReport {
  return {
    from: '2026-09-01',
    to: '2026-09-30',
    companyRuc: '20000000000',
    companyName: 'EMPRESA',
    itemCode: 'BOB038AZUL',
    itemDescription: 'Bobina azul',
    existenceType: '01 - MERCADERÍAS',
    unitCode: '01 - KILOGRAMOS',
    peps: {
      opening: balance,
      rows: [
        {
          movementId: '1',
          operationDate: '2026-09-02',
          inQty: '100.000',
          inUnitCost: '5.0000',
          inTotal: '500.0000',
          outQty: null,
          outUnitCost: null,
          outTotal: null,
          balanceQty: '100.000',
          balanceUnitCost: '5.0000',
          balanceTotal: '500.0000',
          warning: null,
          outLayers: null,
        },
        {
          movementId: '2',
          operationDate: '2026-09-05',
          inQty: null,
          inUnitCost: null,
          inTotal: null,
          outQty: '40.000',
          outUnitCost: '5.0000',
          outTotal: '200.0000',
          balanceQty: '60.000',
          balanceUnitCost: '5.0000',
          balanceTotal: '300.0000',
          warning: 'Faltan 2 kg de capa',
          outLayers: [{ qty: '40.000', unitCost: '5.0000', total: '200.0000' }],
        },
      ],
      closing: { ...balance, qty: '60.000', unitCost: '5.0000', total: '300.0000' },
      totals: { inQty: '100.000', inTotal: '500.0000', outQty: '40.000', outTotal: '200.0000' },
      warnings: ['Faltan 2 kg de capa'],
    },
    documents: new Map([
      [
        '1',
        {
          docTypeCode: '01',
          series: 'F001',
          number: '123',
          operationCode: '02',
          operationLabel: 'COMPRA',
          note: 'Compra a proveedor',
        },
      ],
    ]),
  };
}

describe('kardexPepsToDto', () => {
  it('lleva el documento y la operación de cada fila, y «99 - OTROS» si no tiene', () => {
    const dto = kardexPepsToDto(report());
    expect(dto.rows[0]).toMatchObject({
      docTypeCode: '01',
      series: 'F001',
      number: '123',
      operationCode: '02',
      operationLabel: 'COMPRA',
    });
    expect(dto.rows[1]).toMatchObject({
      docTypeCode: '00',
      series: '',
      number: '',
      operationCode: '99',
      operationLabel: 'OTROS',
    });
  });

  it('la observación junta la nota del movimiento y la advertencia del cálculo, como el Excel', () => {
    const dto = kardexPepsToDto(report());
    expect(dto.rows[0]?.observation).toBe('Compra a proveedor');
    expect(dto.rows[1]?.observation).toBe('Faltan 2 kg de capa');
  });

  it('no recalcula: saldos, totales y advertencias son los del servicio', () => {
    const dto = kardexPepsToDto(report());
    expect(dto.closing.total).toBe('300.0000');
    expect(dto.totals).toEqual({
      inQty: '100.000',
      inTotal: '500.0000',
      outQty: '40.000',
      outTotal: '200.0000',
    });
    expect(dto.warnings).toEqual(['Faltan 2 kg de capa']);
    expect(dto.from).toBe('2026-09-01');
  });
});
