import { Decimal } from '@ayr/shared';
import { planReturnAllocation, type DispatchLineStock } from './sales-return-allocation';

const D = (v: string) => new Decimal(v);

function stock(over: Partial<DispatchLineStock> & { dispatchCode: string }): DispatchLineStock {
  return {
    dispatchItemId: `di-${over.dispatchCode}`,
    dispatchId: `d-${over.dispatchCode}`,
    dispatchDate: '2026-09-10',
    dispatchSeq: 1,
    invoiceId: null,
    itemType: 'PRODUCT',
    itemId: 'p-1',
    qty: D('5'),
    reserveQty: D('5'),
    returnedQty: D('0'),
    returnedReserveQty: D('0'),
    returnedTotalCost: D('0'),
    movementId: 1n,
    unitCost: D('20.0000'),
    totalCost: D('100.0000'),
    unit: 'NIU',
    businessLineId: 'bl-1',
    ...over,
  };
}

describe('planReturnAllocation (cc52, D-646)', () => {
  it('devuelve al costo con que salió, no al promedio de hoy', () => {
    const [a] = planReturnAllocation(1, D('2'), [stock({ dispatchCode: 'DES-1' })]);
    expect(a?.qty.toFixed(3)).toBe('2.000');
    expect(a?.unitCost.toFixed(4)).toBe('20.0000');
    expect(a?.totalCost.toFixed(4)).toBe('40.0000');
  });

  it('sale del despacho más reciente hacia atrás', () => {
    const plan = planReturnAllocation(1, D('7'), [
      stock({ dispatchCode: 'DES-1', dispatchDate: '2026-09-10', dispatchSeq: 1 }),
      stock({
        dispatchCode: 'DES-2',
        dispatchDate: '2026-09-15',
        dispatchSeq: 2,
        unitCost: D('25.0000'),
        totalCost: D('125.0000'),
      }),
    ]);
    expect(
      plan.map((p) => [p.stock.dispatchCode, p.qty.toFixed(3), p.totalCost.toFixed(4)]),
    ).toEqual([
      ['DES-2', '5.000', '125.0000'],
      ['DES-1', '2.000', '40.0000'],
    ]);
  });

  it('lo que queda de la línea se devuelve por su valor exacto, sin redondeos acumulados', () => {
    const [a] = planReturnAllocation(1, D('2'), [
      stock({
        dispatchCode: 'DES-1',
        qty: D('3'),
        reserveQty: D('3'),
        totalCost: D('100.0000'),
        unitCost: D('33.3333'),
        returnedQty: D('1'),
        returnedReserveQty: D('1'),
        returnedTotalCost: D('33.3333'),
      }),
    ]);
    expect(a?.totalCost.toFixed(4)).toBe('66.6667');
  });

  it('nunca más de lo despachado menos lo ya devuelto', () => {
    expect(() =>
      planReturnAllocation(1, D('4'), [stock({ dispatchCode: 'DES-1', returnedQty: D('2') })]),
    ).toThrow('hay 3.000 despachado sin devolver');
  });

  it('en otra unidad de kardex, la parte proporcional', () => {
    const [a] = planReturnAllocation(1, D('1'), [
      stock({
        dispatchCode: 'DES-1',
        qty: D('4'),
        reserveQty: D('100'),
        unitCost: D('5.0000'),
        totalCost: D('500.0000'),
        unit: 'KGM',
      }),
    ]);
    expect(a?.reserveQty.toFixed(3)).toBe('25.000');
    expect(a?.totalCost.toFixed(4)).toBe('125.0000');
  });

  it('una bobina se devuelve entera', () => {
    const coil = stock({
      dispatchCode: 'DES-1',
      itemType: 'COIL',
      qty: D('1'),
      reserveQty: D('2000'),
    });
    expect(() => planReturnAllocation(1, D('0.5'), [coil])).toThrow(
      'una bobina se devuelve entera',
    );
    expect(planReturnAllocation(1, D('1'), [coil])[0]?.reserveQty.toFixed(3)).toBe('2000.000');
  });

  it('primero los despachos del comprobante acreditado; nunca uno posterior a la NC', () => {
    const stock3 = [
      stock({ dispatchCode: 'DES-1', dispatchDate: '2026-09-10', invoiceId: 'F1' }),
      stock({ dispatchCode: 'DES-2', dispatchDate: '2026-09-15', dispatchSeq: 2, invoiceId: 'F2' }),
      stock({ dispatchCode: 'DES-3', dispatchDate: '2026-09-30', dispatchSeq: 3, invoiceId: 'F1' }),
    ];
    const plan = planReturnAllocation(1, D('2'), stock3, {
      affectedInvoiceId: 'F1',
      asOf: '2026-09-20',
    });
    expect(plan.map((p) => p.stock.dispatchCode)).toEqual(['DES-1']);
    expect(() =>
      planReturnAllocation(1, D('11'), stock3, { affectedInvoiceId: 'F1', asOf: '2026-09-20' }),
    ).toThrow('hay 10.000 despachado sin devolver');
  });

  it('una cantidad cero o negativa no se devuelve', () => {
    expect(() => planReturnAllocation(1, D('0'), [stock({ dispatchCode: 'DES-1' })])).toThrow(
      'mayor a cero',
    );
  });
});

describe('cc57 (D-14 de audit-01): una devolución parcial deja kardex para el resto', () => {
  /** Aplica una devolución sobre la línea de despacho, como lo grabaría el servicio. */
  function after(s: DispatchLineStock, qty: string): DispatchLineStock {
    const [a] = planReturnAllocation(1, D(qty), [s]);
    if (!a) throw new Error('sin asignación');
    return {
      ...s,
      returnedQty: s.returnedQty.plus(a.qty),
      returnedReserveQty: s.returnedReserveQty.plus(a.reserveQty),
      returnedTotalCost: s.returnedTotalCost.plus(a.totalCost),
    };
  }

  it('nunca deja unidades afuera sin kardex que devolver', () => {
    // 3 unidades que movieron 0.002 en el kardex: 2 de 3 prorratean 0.00133 → 0.001 y queda 0.001.
    const s = stock({
      dispatchCode: 'DES-1',
      qty: D('3'),
      reserveQty: D('0.002'),
      unitCost: D('5.0000'),
      totalCost: D('0.0100'),
    });
    const rest = after(s, '2');
    const [last] = planReturnAllocation(1, D('1'), [rest]);
    expect(last?.reserveQty.toFixed(3)).toBe('0.001');
    expect(rest.returnedTotalCost.plus(last?.totalCost ?? 0).toFixed(4)).toBe('0.0100');
  });

  it('si el prorrateo se lo llevaría todo, rechaza la parcial y pide devolver el resto entero', () => {
    // Antes: 2 de 3 tomaban todo el 0.001 y la última unidad salía «demasiado chica».
    const s = stock({
      dispatchCode: 'DES-1',
      qty: D('3'),
      reserveQty: D('0.001'),
      unitCost: D('5.0000'),
      totalCost: D('0.0050'),
    });
    expect(() => planReturnAllocation(1, D('2'), [s])).toThrow(
      /demasiado chica para el kardex.*entero \(3\.000\)/,
    );
    const [all] = planReturnAllocation(1, D('3'), [s]);
    expect(all?.reserveQty.toFixed(3)).toBe('0.001');
  });
});
