import {
  buildPlan,
  checkMounted,
  floorCoils,
  materialKeyOf,
  planColors,
  weightedCostPerKg,
  type PlanCoil,
  type PlanReservation,
  type PlanSpec,
} from './commercial-color-plan';

const LINE = 'line-roofing';

const colors = planColors([
  { id: 'rojo', code: 'ROJO', name: 'Rojo', ralCode: '3002', sqlCommercialColor: 'ROJO' },
  {
    id: 'rojo3020',
    code: 'ROJO-3020',
    name: 'Rojo tráfico',
    ralCode: '3020',
    sqlCommercialColor: 'ROJO',
  },
  { id: 'azul', code: 'AZUL-5002', name: 'Azul', ralCode: '5002', sqlCommercialColor: 'AZUL' },
]);

function coil(over: Partial<PlanCoil> & { id: string }): PlanCoil {
  return {
    code: over.id.toUpperCase(),
    businessLineId: LINE,
    thicknessMm: '0.40',
    colorId: null,
    kind: 'PREPINTADO',
    commercialColor: null,
    ralCode: null,
    balanceKg: '0.000',
    avgCostPen: '0.0000',
    heldKg: '0.000',
    reservedOnCoilKg: '0.000',
    ...over,
  };
}

function spec(over: Partial<PlanSpec> & { id: string }): PlanSpec {
  return {
    businessLineId: LINE,
    colorId: null,
    thicknessMm: '0.40',
    quotationLines: 0,
    salesOrderLines: 0,
    lineKinds: [],
    ...over,
  };
}

function reservation(over: Partial<PlanReservation> & { id: string; specId: string }) {
  return {
    temporary: false,
    qtyKg: '0.000',
    documentCode: `PED-${over.id}`,
    documentId: `doc-${over.id}`,
    productSku: 'SKU',
    productKind: 'PREPINTADO',
    productCommercialColor: null,
    productColorId: null,
    ...over,
  } satisfies PlanReservation;
}

describe('materialKeyOf', () => {
  it('da el tipo si no es prepintado y el color comercial si lo es', () => {
    expect(materialKeyOf('GALVANIZADO', null)).toBe('GALVANIZADO');
    expect(materialKeyOf('NATURAL', 'ROJO')).toBe('NATURAL');
    expect(materialKeyOf('PREPINTADO', 'ROJO')).toBe('ROJO');
    expect(materialKeyOf('PREPINTADO', null)).toBeNull();
    expect(materialKeyOf('PREPINTADO', '')).toBeNull();
  });
});

describe('planColors', () => {
  it('marca la diferencia entre SQL y TS y el código que es solo un RAL', () => {
    const rows = planColors([
      { id: 'a', code: 'ROJO-3020', name: 'x', ralCode: null, sqlCommercialColor: 'ROJO3020' },
      { id: 'b', code: 'RAL9010', name: 'x', ralCode: null, sqlCommercialColor: '' },
    ]);
    expect(rows[0]).toMatchObject({ commercialColor: 'ROJO', mismatch: true, empty: false });
    expect(rows[1]).toMatchObject({ commercialColor: '', mismatch: false, empty: true });
  });
});

describe('buildPlan', () => {
  it('funde las specs de dos RAL del mismo color comercial y suma bobinas y reservas', () => {
    const plan = buildPlan({
      colors,
      toleranceMm: '0.02',
      coils: [
        coil({ id: 'c1', colorId: 'rojo', commercialColor: 'ROJO', balanceKg: '100.000' }),
        coil({ id: 'c2', colorId: 'rojo3020', commercialColor: 'ROJO', balanceKg: '300.000' }),
        coil({ id: 'c3', colorId: 'azul', commercialColor: 'AZUL', balanceKg: '999.000' }),
      ],
      specs: [spec({ id: 's-rojo', colorId: 'rojo' }), spec({ id: 's-3020', colorId: 'rojo3020' })],
      reservations: [
        reservation({
          id: '1',
          specId: 's-rojo',
          qtyKg: '250.000',
          productColorId: 'rojo',
          productCommercialColor: 'ROJO',
        }),
      ],
    });

    expect(plan.merges).toHaveLength(1);
    const group = plan.merges[0];
    expect(group?.key).toBe(`${LINE}|ROJO|0.40`);
    expect(group?.sourceSpecIds).toEqual(['s-3020', 's-rojo']);
    // Antes la spec ROJO veía 100 kg y prometía 250: ya estaba en falta. Después ve 400.
    expect(plan.beforeBySpec.get('s-rojo')?.availableKg.toFixed(3)).toBe('-150.000');
    expect(group?.after.physicalKg.toFixed(3)).toBe('400.000');
    expect(group?.after.availableKg.toFixed(3)).toBe('150.000');
    expect(plan.newShortfalls).toHaveLength(0);
    expect(plan.anomalies).toHaveLength(0);
  });

  it('parte una spec sin color por el tipo del producto y detecta la reserva que queda en falta', () => {
    const plan = buildPlan({
      colors,
      toleranceMm: '0.02',
      coils: [
        coil({ id: 'nat', kind: 'NATURAL', balanceKg: '500.000' }),
        coil({ id: 'gal', kind: 'GALVANIZADO', balanceKg: '50.000' }),
      ],
      specs: [spec({ id: 's-null', lineKinds: ['NATURAL', 'GALVANIZADO'] })],
      reservations: [
        reservation({ id: 'n', specId: 's-null', qtyKg: '100.000', productKind: 'NATURAL' }),
        reservation({ id: 'g', specId: 's-null', qtyKg: '120.000', productKind: 'GALVANIZADO' }),
      ],
    });

    expect(plan.splits).toEqual([{ specId: 's-null', kinds: ['GALVANIZADO', 'NATURAL'] }]);
    // Antes: 550 físicos contra 220 prometidos, sobraba.
    expect(plan.beforeBySpec.get('s-null')?.availableKg.toFixed(3)).toBe('330.000');
    const byKey = new Map(plan.groups.map((g) => [g.materialKey, g]));
    expect(byKey.get('NATURAL')?.after.availableKg.toFixed(3)).toBe('400.000');
    expect(byKey.get('GALVANIZADO')?.after.availableKg.toFixed(3)).toBe('-70.000');
    expect(plan.newShortfalls.map((g) => g.materialKey)).toEqual(['GALVANIZADO']);
  });

  it('descuenta la custodia de una corrida a stock y la reserva por ítem solo si la bobina aporta', () => {
    const plan = buildPlan({
      colors,
      toleranceMm: '0.02',
      coils: [
        coil({
          id: 'a',
          colorId: 'rojo',
          commercialColor: 'ROJO',
          balanceKg: '200.000',
          heldKg: '50.000',
          reservedOnCoilKg: '20.000',
        }),
        coil({
          id: 'b',
          colorId: 'rojo',
          commercialColor: 'ROJO',
          balanceKg: '80.000',
          heldKg: '80.000',
          reservedOnCoilKg: '80.000',
        }),
        // Fuera de tolerancia: no cuenta.
        coil({ id: 'c', colorId: 'rojo', commercialColor: 'ROJO', thicknessMm: '0.45' }),
      ],
      specs: [spec({ id: 's', colorId: 'rojo' })],
      reservations: [],
    });
    const a = plan.groups[0]?.after;
    expect(a?.physicalKg.toFixed(3)).toBe('150.000');
    expect(a?.reservedOnCoilsKg.toFixed(3)).toBe('20.000');
    expect(a?.coilCodes).toEqual(['A', 'B']);
  });

  it('reporta como anomalía la reserva cuyo producto ya no tiene el color de su spec', () => {
    const plan = buildPlan({
      colors,
      toleranceMm: '0.02',
      coils: [],
      specs: [spec({ id: 's', colorId: 'rojo' })],
      reservations: [
        reservation({
          id: 'x',
          specId: 's',
          productColorId: 'azul',
          productCommercialColor: 'AZUL',
        }),
        reservation({ id: 'y', specId: 's', productKind: null }),
      ],
    });
    expect(plan.anomalies.map((a) => a.kind).sort()).toEqual([
      'RESERVATION_COLOR_MISMATCH',
      'RESERVATION_KEY_UNKNOWN',
    ]);
  });

  it('no puede sembrar una spec cuyo color no tiene color comercial ni una sin color sin tipo', () => {
    const plan = buildPlan({
      colors: planColors([
        { id: 'ral', code: 'RAL9010', name: 'Blanco', ralCode: '9010', sqlCommercialColor: '' },
      ]),
      toleranceMm: '0.02',
      coils: [],
      specs: [spec({ id: 's1', colorId: 'ral' }), spec({ id: 's2' })],
      reservations: [],
    });
    expect(plan.anomalies.map((a) => a.kind)).toEqual(['SPEC_COLOR_UNKNOWN', 'SPEC_KIND_UNKNOWN']);
  });
});

describe('checkMounted', () => {
  it('una 3020 montada en una OP ROJO pasa a coincidir; una AZUL no', () => {
    const [same, other] = checkMounted([
      {
        orderCode: 'OP-1',
        productSku: 'P',
        productColorId: 'rojo',
        productKind: 'PREPINTADO',
        productCommercialColor: 'ROJO',
        coilCode: 'C',
        coilColorId: 'rojo3020',
        coilKind: 'PREPINTADO',
        coilCommercialColor: 'ROJO',
      },
      {
        orderCode: 'OP-2',
        productSku: 'P',
        productColorId: 'rojo',
        productKind: 'PREPINTADO',
        productCommercialColor: 'ROJO',
        coilCode: 'D',
        coilColorId: 'azul',
        coilKind: 'PREPINTADO',
        coilCommercialColor: 'AZUL',
      },
    ]);
    expect(same).toMatchObject({ matchesBefore: false, matchesAfter: true });
    expect(other).toMatchObject({ matchesBefore: false, matchesAfter: false });
  });
});

describe('piso de precio', () => {
  it('pondera el costo por los kilos y el grupo nuevo suma los RAL hermanos', () => {
    const coils = [
      coil({
        id: 'a',
        colorId: 'rojo',
        commercialColor: 'ROJO',
        balanceKg: '100',
        avgCostPen: '4',
      }),
      coil({
        id: 'b',
        colorId: 'rojo3020',
        commercialColor: 'ROJO',
        balanceKg: '300',
        avgCostPen: '2',
      }),
      coil({ id: 'z', colorId: 'rojo3020', commercialColor: 'ROJO', balanceKg: '0' }),
    ];
    const { before, after } = floorCoils(
      coils,
      { businessLineId: LINE, thicknessMm: '0.40', colorId: 'rojo' },
      'ROJO',
      '0.02',
    );
    expect(weightedCostPerKg(before).toFixed(4)).toBe('4.0000');
    expect(weightedCostPerKg(after).toFixed(4)).toBe('2.5000');
    expect(weightedCostPerKg([]).toFixed(4)).toBe('0.0000');
    expect(
      floorCoils(coils, { businessLineId: LINE, thicknessMm: '0.40', colorId: null }, null, '0.02')
        .after,
    ).toEqual([]);
  });
});
