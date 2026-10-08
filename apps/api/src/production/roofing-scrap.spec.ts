import { BadRequestException } from '@nestjs/common';
import { Decimal } from '@ayr/shared';
import { allocateRoofingScrap, type RoofingScrapInput } from './roofing-scrap';

const d = (v: string) => new Decimal(v);

/** Dos bobinas vivas montadas en orden: A primero, B después, con 200 kg de saldo cada una. */
function twoCoils(overrides: Partial<RoofingScrapInput> = {}): RoofingScrapInput {
  return {
    rows: [
      { consumptionId: 'rA', coilId: 'A', coilCode: 'BOB-A', remainingKg: d('200') },
      { consumptionId: 'rB', coilId: 'B', coilCode: 'BOB-B', remainingKg: d('200') },
    ],
    reports: [],
    outs: [],
    explicitTotalKg: null,
    ...overrides,
  };
}

const byCoil = (r: ReturnType<typeof allocateRoofingScrap>) =>
  Object.fromEntries(r.allocations.map((a) => [a.coilId, a.kg.toFixed(3)]));

describe('allocateRoofingScrap (cc34 B1: el despunte de cada bobina sale de sus partes)', () => {
  it('A montada primero y B declara 120 sobre 100: los 20 kg salen de B, no de A', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [
          { id: 'p1', declaredKg: null },
          { id: 'p2', declaredKg: d('120') },
        ],
        outs: [
          { reportId: 'p1', coilId: 'A', kg: d('100') },
          { reportId: 'p2', coilId: 'B', kg: d('100') },
        ],
      }),
    );
    expect(result.scrapKg.toFixed(3)).toBe('20.000');
    expect(result.declaredKg.toFixed(3)).toBe('220.000');
    expect(byCoil(result)).toEqual({ B: '20.000' });
  });

  it('A en 90/100 y B en 120/100: 20 kg en B y nada en A (sin compensar entre bobinas)', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [
          { id: 'p1', declaredKg: d('90') },
          { id: 'p2', declaredKg: d('120') },
        ],
        outs: [
          { reportId: 'p1', coilId: 'A', kg: d('100') },
          { reportId: 'p2', coilId: 'B', kg: d('100') },
        ],
      }),
    );
    expect(result.scrapKg.toFixed(3)).toBe('20.000');
    expect(byCoil(result)).toEqual({ B: '20.000' });
  });

  it('dentro de una misma bobina, un parte de menos sí compensa a otro de más', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [
          { id: 'p1', declaredKg: d('45') },
          { id: 'p2', declaredKg: d('60') },
        ],
        outs: [
          { reportId: 'p1', coilId: 'B', kg: d('50') },
          { reportId: 'p2', coilId: 'B', kg: d('50') },
        ],
      }),
    );
    expect(byCoil(result)).toEqual({ B: '5.000' });
  });

  it('un total escrito con dos bobinas se reparte en proporción a lo reportado de cada una', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [
          { id: 'p1', declaredKg: null },
          { id: 'p2', declaredKg: null },
        ],
        outs: [
          { reportId: 'p1', coilId: 'A', kg: d('30') },
          { reportId: 'p2', coilId: 'B', kg: d('90') },
        ],
        explicitTotalKg: d('140'),
      }),
    );
    expect(result.scrapKg.toFixed(3)).toBe('20.000');
    expect(byCoil(result)).toEqual({ A: '5.000', B: '15.000' });
  });

  it('el total escrito manda sobre lo declarado por parte', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [{ id: 'p2', declaredKg: d('150') }],
        outs: [
          { reportId: 'p2', coilId: 'A', kg: d('50') },
          { reportId: 'p2', coilId: 'B', kg: d('50') },
        ],
        explicitTotalKg: d('110'),
      }),
    );
    expect(byCoil(result)).toEqual({ A: '5.000', B: '5.000' });
  });

  it('el reparto proporcional se topa en el saldo y el sobrante va a la siguiente con saldo', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        rows: [
          { consumptionId: 'rA', coilId: 'A', coilCode: 'BOB-A', remainingKg: d('200') },
          { consumptionId: 'rB', coilId: 'B', coilCode: 'BOB-B', remainingKg: d('4') },
        ],
        reports: [{ id: 'p1', declaredKg: null }],
        outs: [
          { reportId: 'p1', coilId: 'A', kg: d('50') },
          { reportId: 'p1', coilId: 'B', kg: d('50') },
        ],
        explicitTotalKg: d('120'),
      }),
    );
    expect(byCoil(result)).toEqual({ A: '16.000', B: '4.000' });
  });

  it('lo declarado por parte también se topa en el saldo de su bobina y el resto pasa a otra', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        rows: [
          { consumptionId: 'rA', coilId: 'A', coilCode: 'BOB-A', remainingKg: d('200') },
          { consumptionId: 'rB', coilId: 'B', coilCode: 'BOB-B', remainingKg: d('3') },
        ],
        reports: [{ id: 'p2', declaredKg: d('110') }],
        outs: [{ reportId: 'p2', coilId: 'B', kg: d('100') }],
      }),
    );
    expect(byCoil(result)).toEqual({ A: '7.000', B: '3.000' });
  });

  it('con una sola bobina viva, todo el despunte va a ella (igual que antes)', () => {
    const result = allocateRoofingScrap({
      rows: [{ consumptionId: 'rA', coilId: 'A', coilCode: 'BOB-A', remainingKg: d('200') }],
      reports: [
        { id: 'p1', declaredKg: d('90') },
        { id: 'p2', declaredKg: d('130') },
      ],
      outs: [
        { reportId: 'p1', coilId: 'A', kg: d('100') },
        { reportId: 'p2', coilId: 'A', kg: d('100') },
      ],
      explicitTotalKg: null,
    });
    // Con una bobina el piso es global, como hasta hoy: 90 + 130 − 200 = 20.
    expect(result.scrapKg.toFixed(3)).toBe('20.000');
    expect(byCoil(result)).toEqual({ A: '20.000' });
  });

  it('una bobina con dos filas vivas reparte su despunte entre ellas en orden de montaje', () => {
    const result = allocateRoofingScrap({
      rows: [
        { consumptionId: 'r1', coilId: 'A', coilCode: 'BOB-A', remainingKg: d('5') },
        { consumptionId: 'r2', coilId: 'A', coilCode: 'BOB-A', remainingKg: d('50') },
      ],
      reports: [{ id: 'p1', declaredKg: d('112') }],
      outs: [{ reportId: 'p1', coilId: 'A', kg: d('100') }],
      explicitTotalKg: null,
    });
    expect(result.allocations.map((a) => [a.consumptionId, a.kg.toFixed(3)])).toEqual([
      ['r1', '5.000'],
      ['r2', '7.000'],
    ]);
  });

  it('un parte sin salida de kardex cuenta su teórico en la primera bobina viva', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [{ id: 'p1', declaredKg: d('110'), theoreticalKg: d('100') }],
        outs: [],
      }),
    );
    expect(result.reportedKg.toFixed(3)).toBe('100.000');
    expect(byCoil(result)).toEqual({ A: '10.000' });
  });

  it('un parte repartido entre dos bobinas reparte su exceso en proporción a lo que sacó de cada una', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [{ id: 'p1', declaredKg: d('120') }],
        outs: [
          { reportId: 'p1', coilId: 'A', kg: d('75') },
          { reportId: 'p1', coilId: 'B', kg: d('25') },
        ],
      }),
    );
    expect(byCoil(result)).toEqual({ A: '15.000', B: '5.000' });
  });

  it('el redondeo cierra exacto: la suma de lo repartido es el despunte', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [{ id: 'p1', declaredKg: null }],
        outs: [
          { reportId: 'p1', coilId: 'A', kg: d('1') },
          { reportId: 'p1', coilId: 'B', kg: d('2') },
        ],
        explicitTotalKg: d('4'),
      }),
    );
    const sum = result.allocations.reduce((acc, a) => acc.plus(a.kg), new Decimal(0));
    expect(sum.toFixed(3)).toBe('1.000');
    expect(byCoil(result)).toEqual({ A: '0.333', B: '0.667' });
  });

  it('con cuatro bobinas y pocos gramos, ninguna cuota sale negativa y lo repartido es el despunte', () => {
    const rows = ['A', 'B', 'C', 'D'].map((id) => ({
      consumptionId: `r${id}`,
      coilId: id,
      coilCode: `BOB-${id}`,
      remainingKg: d('50'),
    }));
    const result = allocateRoofingScrap({
      rows,
      reports: [{ id: 'p1', declaredKg: null }],
      outs: [
        { reportId: 'p1', coilId: 'A', kg: d('1000') },
        { reportId: 'p1', coilId: 'B', kg: d('1000') },
        { reportId: 'p1', coilId: 'C', kg: d('1000') },
        { reportId: 'p1', coilId: 'D', kg: d('0.001') },
      ],
      // Redondear al medio daba 0.002 a A, B y C y −0.001 a D: 0.006 al kardex contra 0.005.
      explicitTotalKg: d('3000.006'),
    });
    expect(result.scrapKg.toFixed(3)).toBe('0.005');
    expect(result.allocations.every((a) => a.kg.gt(0))).toBe(true);
    const sum = result.allocations.reduce((acc, a) => acc.plus(a.kg), new Decimal(0));
    expect(sum.toFixed(3)).toBe('0.005');
    expect(byCoil(result)).toEqual({ A: '0.003', B: '0.001', C: '0.001' });
  });

  it('un total escrito sin nada reportado en las bobinas vivas va en orden de montaje', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [{ id: 'p1', declaredKg: null }],
        outs: [{ reportId: 'p1', coilId: 'X', kg: d('100') }],
        explicitTotalKg: d('110'),
      }),
    );
    expect(byCoil(result)).toEqual({ A: '10.000' });
  });

  it('sin exceso no hay asignaciones', () => {
    const result = allocateRoofingScrap(
      twoCoils({
        reports: [{ id: 'p1', declaredKg: d('80') }],
        outs: [{ reportId: 'p1', coilId: 'A', kg: d('100') }],
      }),
    );
    expect(result.scrapKg.toFixed(3)).toBe('0.000');
    expect(result.declaredKg.toFixed(3)).toBe('100.000');
    expect(result.allocations).toEqual([]);
  });

  it('un total escrito menor que lo reportado se rechaza', () => {
    expect(() =>
      allocateRoofingScrap(
        twoCoils({
          reports: [{ id: 'p1', declaredKg: null }],
          outs: [{ reportId: 'p1', coilId: 'A', kg: d('100') }],
          explicitTotalKg: d('90'),
        }),
      ),
    ).toThrow(/ya consumieron 100\.000 kg/);
  });

  it('un despunte que no entra en lo montado se rechaza', () => {
    expect(() =>
      allocateRoofingScrap(
        twoCoils({
          reports: [{ id: 'p1', declaredKg: null }],
          outs: [{ reportId: 'p1', coilId: 'A', kg: d('100') }],
          explicitTotalKg: d('600'),
        }),
      ),
    ).toThrow(BadRequestException);
  });
});
