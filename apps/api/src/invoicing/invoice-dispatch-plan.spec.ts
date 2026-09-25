import { Decimal } from '@ayr/shared';
import {
  allocateUndispatched,
  planInvoiceDispatches,
  type PlanInvoice,
  type PlanItemKardex,
} from './invoice-dispatch-plan';

const d = (v: string | number): Decimal => new Decimal(v);

function invoice(
  number: string,
  issueDate: string,
  lines: {
    itemKey: string | null;
    qty: string;
    reserveQty?: string;
    blocked?: string;
  }[],
): PlanInvoice {
  return {
    invoiceId: number,
    number,
    salesOrderId: 'ped',
    issueDate,
    lines: lines.map((l, i) => ({
      orderItemId: `${number}-${String(i + 1)}`,
      lineNumber: i + 1,
      sku: l.itemKey ?? 'X',
      qty: d(l.qty),
      target:
        l.blocked !== undefined || l.itemKey === null
          ? { ok: false, reason: l.blocked ?? 'sin destino' }
          : { ok: true, itemKey: l.itemKey, reserveQty: d(l.reserveQty ?? l.qty) },
    })),
  };
}

function kardex(openingDate: string | null, moves: [string, number][]): PlanItemKardex {
  return {
    openingDate,
    movements: moves.map(([date, qty]) => ({ date, signedQty: d(qty) })),
  };
}

describe('planInvoiceDispatches (D-278)', () => {
  it('despacha a la fecha del comprobante cuando el kardex alcanza ese día', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-10', [{ itemKey: 'A', qty: '30' }])],
      new Map([['A', kardex('2026-09-07', [['2026-09-07', 100]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'DISPATCH', operationDate: '2026-09-10' });
  });

  it('comprobante anterior al saldo inicial: sin salida, solo entrega (la excepción)', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-08-11', [{ itemKey: 'UPVC', qty: '50' }])],
      new Map([['UPVC', kardex('2026-09-22', [['2026-09-22', 970]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'BEFORE_OPENING' });
  });

  it('el mismo día del saldo inicial no es anterior: se despacha', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-22', [{ itemKey: 'UPVC', qty: '50' }])],
      new Map([['UPVC', kardex('2026-09-22', [['2026-09-22', 970]])]]),
    );
    expect(plan[0]?.lines[0]?.action).toBe('DISPATCH');
  });

  it('sin carga inicial y con la entrada posterior al comprobante: el kardex quedaría negativo → revisión', () => {
    // Coberturas facturadas en agosto y producidas en septiembre.
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-08-05', [{ itemKey: 'COB', qty: '226.8' }])],
      new Map([['COB', kardex(null, [['2026-09-15', 600]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'REVIEW' });
    expect(plan[0]?.lines[0]?.reason).toContain('2026-08-05');
  });

  it('una salida intermedia del kardex también cuenta: negativo en una fecha posterior → revisión', () => {
    // 100 el 01, sale 80 el 05, entran 50 el 09. Una salida de 30 el 02 deja -10 el 05.
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-02', [{ itemKey: 'A', qty: '30' }])],
      new Map([
        [
          'A',
          kardex(null, [
            ['2026-09-01', 100],
            ['2026-09-05', -80],
            ['2026-09-09', 50],
          ]),
        ],
      ]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'REVIEW' });
    expect(plan[0]?.lines[0]?.reason).toContain('2026-09-05');
  });

  it('las salidas del mismo plan se acumulan: la segunda que no cabe va a revisión', () => {
    const plan = planInvoiceDispatches(
      [
        invoice('F1', '2026-09-10', [{ itemKey: 'A', qty: '60' }]),
        invoice('F2', '2026-09-11', [{ itemKey: 'A', qty: '60' }]),
      ],
      new Map([['A', kardex(null, [['2026-09-01', 100]])]]),
    );
    expect(plan.map((p) => p.lines[0]?.action)).toEqual(['DISPATCH', 'REVIEW']);
  });

  it('la salida usa la cantidad del kardex (kilos de la bobina), no la de venta', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-08-01', [{ itemKey: 'BOB', qty: '1', reserveQty: '3866' }])],
      new Map([['BOB', kardex(null, [['2026-08-01', 3866]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'DISPATCH' });
    expect(plan[0]?.lines[0]?.reserveQty.toFixed(3)).toBe('3866.000');
  });

  it('una línea sin producto terminado (producción no reportada) va a revisión con el motivo', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-10', [{ itemKey: 'A', qty: '5', blocked: 'produce lo que falta' }])],
      new Map(),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'REVIEW', reason: 'produce lo que falta' });
  });
});

describe('allocateUndispatched (D-278)', () => {
  it('lo ya despachado cubre primero los comprobantes más antiguos', () => {
    // Línea de 100, dos facturas de 40 y 60, 50 ya despachados: la primera queda cubierta y
    // de la segunda faltan 50.
    expect(allocateUndispatched(d(100), d(50), [d(40), d(60)]).map((q) => q.toFixed(3))).toEqual([
      '0.000',
      '50.000',
    ]);
  });

  it('nunca más que lo pendiente del pedido', () => {
    expect(allocateUndispatched(d(10), d(0), [d(8), d(8)]).map((q) => q.toFixed(3))).toEqual([
      '8.000',
      '2.000',
    ]);
  });
});

describe('planInvoiceDispatches — bobinas (autorrevisión P2-3)', () => {
  it('una bobina de la carga inicial no se entrega sin salida: va a revisión', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-08-11', [{ itemKey: 'COIL:b1', qty: '1', reserveQty: '3000' }])],
      new Map([['COIL:b1', kardex('2026-09-22', [['2026-09-22', 3000]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'REVIEW' });
    expect(plan[0]?.lines[0]?.reason).toContain('inventario inicial');
  });
});

describe('planInvoiceDispatches — fecha del parte de producción (D-285)', () => {
  it('la salida va el día más tardío entre la emisión y el parte de producción', () => {
    const inv = invoice('F1', '2026-08-05', [{ itemKey: 'COB', qty: '226.8' }]);
    inv.lines[0]!.notBefore = '2026-09-15';
    const plan = planInvoiceDispatches(
      [inv],
      new Map([['COB', kardex(null, [['2026-09-15', 600]])]]),
    );
    expect(plan[0]?.lines[0]).toMatchObject({ action: 'DISPATCH', operationDate: '2026-09-15' });
  });

  it('las salidas previas del mismo arreglo se suman al kardex simulado', () => {
    const plan = planInvoiceDispatches(
      [invoice('F1', '2026-09-10', [{ itemKey: 'A', qty: '60' }])],
      new Map([['A', kardex(null, [['2026-09-01', 100]])]]),
      new Map([['A', [{ date: '2026-09-02', qty: new Decimal(50) }]]]),
    );
    expect(plan[0]?.lines[0]?.action).toBe('REVIEW');
  });
});
