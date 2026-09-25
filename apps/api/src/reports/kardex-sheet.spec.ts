import {
  movementsToKardexSheet,
  pepsToKardexSheet,
  type InventoryMovementDto,
  type KardexPepsReportDto,
} from '@ayr/shared';

// D-298: la hoja del cliente es presentación de números que ya existen; no calcula nada.
function movement(overrides: Partial<InventoryMovementDto>): InventoryMovementDto {
  return {
    id: '1',
    businessLine: 'drywall',
    itemType: 'COIL',
    itemId: '00000000-0000-4000-8000-000000000001',
    itemLabel: 'BOB-1',
    type: 'IN',
    qty: '100.000',
    unit: 'KGM',
    unitCost: '5.0000',
    totalCost: '500.0000',
    refType: 'PURCHASE',
    refId: null,
    notes: null,
    at: '2026-09-02T10:00:00.000Z',
    operationDate: '2026-09-02',
    balanceQty: '100.000',
    balanceAvgCost: '5.0000',
    balanceTotalCost: '500.0000',
    reversalOfId: null,
    reversedById: null,
    actorId: null,
    actorName: null,
    ...overrides,
  } as InventoryMovementDto;
}

const meta = {
  itemCode: 'BOB-1',
  itemDescription: 'Bobina',
  from: '2026-09-01',
  to: '2026-09-30',
  unit: 'KGM',
};

describe('movementsToKardexSheet (promedio)', () => {
  it('una entrada va en ENTRADAS y una salida en SALIDAS, con el saldo corrido del kardex', () => {
    const sheet = movementsToKardexSheet(
      [
        movement({}),
        movement({
          id: '2',
          type: 'OUT',
          qty: '40.000',
          unitCost: '5.0000',
          totalCost: '200.0000',
          refType: 'SALE',
          operationDate: '2026-09-05',
          balanceQty: '60.000',
          balanceTotalCost: '300.0000',
        }),
      ],
      meta,
    );
    expect(sheet.method).toBe('AVERAGE');
    expect(sheet.rows[0]).toMatchObject({
      inQty: '100.000',
      inUnitCost: '5.0000',
      inTotal: '500.0000',
      outQty: null,
      balanceQty: '100.000',
      balanceUnitCost: '5.0000',
      balanceTotal: '500.0000',
    });
    expect(sheet.rows[1]).toMatchObject({
      inQty: null,
      outQty: '40.000',
      outTotal: '200.0000',
      balanceQty: '60.000',
      balanceTotal: '300.0000',
    });
  });

  it('un ajuste de costo mueve valor sin cantidad: suma en entradas, resta en salidas', () => {
    const up = movementsToKardexSheet(
      [movement({ type: 'ADJUST', totalCost: '25.0000', unitCost: '0.2500' })],
      meta,
    ).rows[0];
    expect(up).toMatchObject({ inQty: null, inUnitCost: null, inTotal: '25.0000', outTotal: null });
    const down = movementsToKardexSheet(
      [movement({ type: 'ADJUST', totalCost: '-25.0000', unitCost: '-0.2500' })],
      meta,
    ).rows[0];
    expect(down).toMatchObject({
      outQty: null,
      outUnitCost: null,
      outTotal: '25.0000',
      inTotal: null,
    });
  });

  it('marca la anulación en el detalle y lleva la nota', () => {
    const row = movementsToKardexSheet(
      [movement({ reversalOfId: '9', notes: 'Error de carga' })],
      meta,
    ).rows[0];
    expect(row?.detail).toBe('Compra (anulación) · Error de carga');
  });
});

describe('pepsToKardexSheet', () => {
  const layer = (qty: string, unitCost: string, total: string) => ({ qty, unitCost, total });
  const base = {
    docTypeCode: '00',
    series: '',
    number: '',
    operationCode: '99',
    operationLabel: 'OTROS',
    inQty: null,
    inUnitCost: null,
    inTotal: null,
    outQty: null,
    outUnitCost: null,
    outTotal: null,
    observation: null,
    outLayers: null,
  };
  const report: KardexPepsReportDto = {
    from: '2026-09-01',
    to: '2026-09-30',
    itemCode: 'BOB-1',
    itemDescription: 'Bobina',
    unitCode: '01 - KILOGRAMOS',
    opening: { qty: '0.000', unitCost: '0.0000', total: '0.0000', layers: [] },
    rows: [
      {
        ...base,
        movementId: '1',
        operationDate: '2026-09-01',
        operationCode: '02',
        operationLabel: 'COMPRA',
        inQty: '100.000',
        inUnitCost: '10.0000',
        inTotal: '1000.0000',
        balanceQty: '100.000',
        balanceUnitCost: '10.0000',
        balanceTotal: '1000.0000',
      },
      {
        ...base,
        movementId: '2',
        operationDate: '2026-09-03',
        operationCode: '01',
        operationLabel: 'VENTA',
        docTypeCode: '01',
        series: 'F001',
        number: '15',
        outQty: '120.000',
        outUnitCost: '10.3333',
        outTotal: '1240.0000',
        outLayers: [
          layer('100.000', '10.0000', '1000.0000'),
          layer('20.000', '12.0000', '240.0000'),
        ],
        balanceQty: '30.000',
        balanceUnitCost: '12.0000',
        balanceTotal: '360.0000',
      },
    ],
    closing: { qty: '30.000', unitCost: '12.0000', total: '360.0000', layers: [] },
    totals: { inQty: '150.000', inTotal: '1600.0000', outQty: '120.000', outTotal: '1240.0000' },
    warnings: [],
  };

  it('abre el saldo inicial, una fila por capa en la salida y los totales', () => {
    const sheet = pepsToKardexSheet(report);
    expect(sheet.method).toBe('PEPS');
    expect(sheet.rows.map((r) => r.kind)).toEqual([
      'opening',
      'movement',
      'movement',
      'movement',
      'totals',
    ]);
    expect(sheet.rows[0]?.detail).toBe('Saldo inicial');
    // La salida de 120 kg sobre dos capas: dos filas con la misma fecha y detalle.
    const [first, second] = [sheet.rows[2], sheet.rows[3]];
    expect(first?.date).toBe('2026-09-03');
    expect(second?.date).toBe('2026-09-03');
    expect(first?.detail).toBe('01 F001-15 · VENTA');
    expect(second?.detail).toBe(first?.detail);
    expect(first).toMatchObject({
      outQty: '100.000',
      outUnitCost: '10.0000',
      outTotal: '1000.0000',
    });
    expect(second).toMatchObject({
      outQty: '20.000',
      outUnitCost: '12.0000',
      outTotal: '240.0000',
    });
    // El saldo (cantidad y monto totales del movimiento) va solo en la última fila de la salida.
    expect(first?.balanceQty).toBeNull();
    expect(second).toMatchObject({
      balanceQty: '30.000',
      balanceUnitCost: '12.0000',
      balanceTotal: '360.0000',
    });
    // Las capas suman lo que declara el movimiento.
    expect(1000 + 240).toBe(Number(report.rows[1]?.outTotal));
    expect(sheet.rows[4]).toMatchObject({
      inQty: '150.000',
      outTotal: '1240.0000',
      balanceTotal: '360.0000',
    });
  });

  it('una salida de una sola capa es una sola fila', () => {
    const single = pepsToKardexSheet({
      ...report,
      rows: [
        {
          ...report.rows[1]!,
          outLayers: [layer('120.000', '10.0000', '1200.0000')],
        },
      ],
    });
    expect(single.rows.filter((r) => r.kind === 'movement')).toHaveLength(1);
    expect(single.rows[1]?.balanceQty).toBe('30.000');
  });
});
