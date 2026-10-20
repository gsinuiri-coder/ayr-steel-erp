import { Decimal, hasCollectibleBalance } from '@ayr/shared';
import {
  parseAmount,
  parseMethod,
  planOpeningBalances,
  type OpeningAccount,
  type OpeningRow,
  type PlanOptions,
} from './opening-balances-plan';

const options = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  cutoff: '2026-09-30',
  missing: 'PENDING',
  historicalFloor: '2026-08-01',
  noun: { account: 'comprobante', payment: 'cobro' },
  ...over,
});

const account = (key: string, over: Partial<OpeningAccount> = {}): OpeningAccount => ({
  id: `id-${key}`,
  key,
  issueDate: '2026-08-10',
  netAtCutoff: new Decimal('1180.0000'),
  paidUpToCutoff: new Decimal(0),
  payableNow: new Decimal('1180.00'),
  ...over,
});

let n = 1;
const row = (key: string, over: Partial<OpeningRow> = {}): OpeningRow => ({
  rowNumber: ++n,
  key,
  date: '',
  amount: '',
  method: '',
  reference: '',
  balance: '',
  ...over,
});

describe('parseAmount', () => {
  it.each([
    ['1234.56', '1234.56'],
    ['1 234,56', '1234.56'],
    ['1.234,56', '1234.56'],
    ['1,234.56', '1234.56'],
    ['S/ 1180', '1180'],
    ['S/. 1180,50', '1180.5'],
    ['1234,5', '1234.5'],
    ['1,234', '1234'],
    ['0', '0'],
  ])('%s → %s', (raw, expected) => {
    expect(parseAmount(raw)?.toString()).toBe(expected);
  });

  it.each(['', 'abc', '12a', '1.2.3,4,5'])('%s no es un número', (raw) => {
    expect(parseAmount(raw)).toBeNull();
  });
});

describe('parseMethod', () => {
  it.each([
    ['Transferencia', 'TRANSFER'],
    ['deposito', 'DEPOSIT'],
    ['Depósito', 'DEPOSIT'],
    ['YAPE', 'WALLET'],
    ['Yape / Plin', 'WALLET'],
    ['cash', 'CASH'],
    ['Otro', 'OTHER'],
  ])('%s → %s', (raw, expected) => {
    expect(parseMethod(raw)).toBe(expected);
  });

  it('un medio desconocido es null', () => {
    expect(parseMethod('trueque')).toBeNull();
  });
});

describe('planOpeningBalances', () => {
  it('registra cada fila de cobro con su fecha, medio y referencia', () => {
    const plan = planOpeningBalances(
      [account('F1')],
      [
        row('F1', {
          date: '2026-08-20',
          amount: '500',
          method: 'Transferencia',
          reference: 'OP 1',
        }),
        row('F1', { date: '05/09/2026', amount: '300,50', method: 'Depósito' }),
      ],
      options(),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.payments.map((p) => [p.date, p.amount, p.method, p.reference, p.source])).toEqual([
      ['2026-08-20', '500.00', 'TRANSFER', 'OP 1', 'ROW'],
      ['2026-09-05', '300.50', 'DEPOSIT', null, 'ROW'],
    ]);
    expect(plan.totalRegistered).toBe('800.50');
    expect(plan.accounts[0]).toMatchObject({
      balanceAtCutoffBefore: '1180.00',
      registered: '800.50',
      balanceAtCutoffAfter: '379.50',
      treatment: 'EXCEL',
    });
  });

  it('con saldo al corte registra la diferencia, a la fecha de corte', () => {
    const plan = planOpeningBalances([account('F1')], [row('F1', { balance: '180' })], options());
    expect(plan.errors).toEqual([]);
    expect(plan.payments).toEqual([
      expect.objectContaining({
        date: '2026-09-30',
        amount: '1000.00',
        source: 'BALANCE',
        method: 'OTHER',
      }),
    ]);
  });

  it('saldo al corte igual a lo que se debía: no registra nada', () => {
    const plan = planOpeningBalances([account('F1')], [row('F1', { balance: '1180' })], options());
    expect(plan.payments).toEqual([]);
    expect(plan.accounts[0]?.treatment).toBe('EXCEL');
  });

  it('saldo al corte 0 salda el comprobante, también con cola de diezmilésimas (D-169, D-700)', () => {
    const plan = planOpeningBalances(
      [
        account('F1', {
          netAtCutoff: new Decimal('1180.0049'),
          payableNow: new Decimal('1180.01'),
        }),
      ],
      [row('F1', { balance: '0' })],
      options(),
    );
    // cc61 (D-700): al céntimo HALF_UP, como los comprobantes; el resto (0,0049) no es deuda (D-377).
    expect(plan.payments[0]?.amount).toBe('1180.00');
    expect(hasCollectibleBalance(new Decimal('1180.0049').minus('1180.00'))).toBe(false);
  });

  it('descuenta lo ya cobrado en la app hasta el corte', () => {
    const plan = planOpeningBalances(
      [account('F1', { paidUpToCutoff: new Decimal(400), payableNow: new Decimal('780.00') })],
      [row('F1', { balance: '0' })],
      options(),
    );
    expect(plan.payments[0]?.amount).toBe('780.00');
  });

  it('lo que no aparece y la opción es «sigue pendiente»: no se toca', () => {
    const plan = planOpeningBalances(
      [account('F1'), account('F2')],
      [row('F1', { balance: '0' })],
      options(),
    );
    expect(plan.payments.map((p) => p.key)).toEqual(['F1']);
    expect(plan.accounts.find((a) => a.key === 'F2')?.treatment).toBe('MISSING_PENDING');
  });

  it('lo que no aparece y la opción es «pagado al corte»: un cobro por todo, al corte', () => {
    const plan = planOpeningBalances(
      [
        account('F1'),
        account('F2', { netAtCutoff: new Decimal(500), payableNow: new Decimal(500) }),
      ],
      [row('F1', { balance: '1180' }), row('F2')],
      options({ missing: 'PAID' }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.payments).toEqual([
      expect.objectContaining({
        key: 'F2',
        amount: '500.00',
        date: '2026-09-30',
        source: 'MISSING_PAID',
      }),
    ]);
  });

  it('«pagado al corte» sin saldo que cobrar no registra nada', () => {
    const plan = planOpeningBalances(
      [account('F1', { payableNow: new Decimal(0), paidUpToCutoff: new Decimal('1180') })],
      [],
      options({ missing: 'PAID' }),
    );
    expect(plan.payments).toEqual([]);
    expect(plan.accounts[0]?.treatment).toBe('MISSING_PAID');
  });

  it('un comprobante emitido después del corte no se toca, y en el Excel es error', () => {
    const late = account('F9', { issueDate: '2026-10-02' });
    const silent = planOpeningBalances([late], [], options({ missing: 'PAID' }));
    expect(silent.payments).toEqual([]);
    expect(silent.accounts[0]?.treatment).toBe('AFTER_CUTOFF');
    const loud = planOpeningBalances([late], [row('F9', { balance: '0' })], options());
    expect(loud.errors[0]?.message).toMatch(/después del corte/);
  });

  it.each([
    [{ amount: '100', balance: '0' }, /no las dos cosas/],
    [{ amount: '-5' }, /monto inválido/],
    [{ amount: '1.234' }, /monto inválido|dos decimales/],
    [{ amount: '10.555' }, /dos decimales/],
    [{ amount: '100', date: '31/02/2026' }, /fecha inválida/],
    [{ amount: '100', date: '2026-10-05' }, /posterior al corte/],
    [{ amount: '100', date: '2026-07-31' }, /carga histórica/],
    [{ amount: '100', method: 'trueque' }, /medio de pago desconocido/],
    [{ balance: '-1' }, /saldo al corte inválido/],
    [{ balance: '2000' }, /mayor que lo que se debía/],
    [{ amount: '2000' }, /suman 2000.00/],
  ])('rechaza %o', (over, message) => {
    const plan = planOpeningBalances([account('F1')], [row('F1', over)], options());
    expect(plan.errors.map((e) => e.message).join(' | ')).toMatch(message);
    expect(plan.payments).toEqual([]);
  });

  it('un comprobante inexistente, ambiguo o sin clave es error', () => {
    const plan = planOpeningBalances(
      [account('F1'), account('F2'), { ...account('F2'), id: 'otro' }],
      [row('NO-EXISTE', { balance: '0' }), row('F2', { balance: '0' }), row('', { balance: '0' })],
      options(),
    );
    expect(plan.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/inexistente/),
      expect.stringMatching(/ambiguo/),
      'falta el comprobante',
    ]);
  });

  it('saldo al corte con otra fila del mismo comprobante es error', () => {
    const plan = planOpeningBalances(
      [account('F1')],
      [row('F1', { balance: '0' }), row('F1', { amount: '10', date: '2026-09-01' })],
      options(),
    );
    expect(plan.errors[0]?.message).toMatch(/una sola fila/);
  });

  it('no registra más de lo que hoy se puede cobrar (NC posterior al corte)', () => {
    const plan = planOpeningBalances(
      [account('F1', { payableNow: new Decimal(500) })],
      [row('F1', { balance: '0' })],
      options(),
    );
    expect(plan.errors[0]?.message).toMatch(/hoy solo se puede 500.00/);
    const rows = planOpeningBalances(
      [account('F1', { payableNow: new Decimal(500) })],
      [row('F1', { amount: '600', date: '2026-09-01' })],
      options(),
    );
    expect(rows.errors[0]?.message).toMatch(/hoy se puede registrar hasta 500.00/);
  });

  it('avisa sin bloquear: medio vacío, fecha vacía y fecha anterior a la emisión', () => {
    const plan = planOpeningBalances(
      [account('F1')],
      [
        row('F1', { amount: '100' }),
        row('F1', { amount: '50', date: '2026-08-05', method: 'Efectivo' }),
      ],
      options(),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.warnings.map((w) => w.message)).toEqual([
      'sin medio de pago: se registra como «Otro»',
      'sin fecha: se registra al corte (2026-09-30)',
      'la fecha 2026-08-05 es anterior a la emisión (2026-08-10)',
    ]);
    expect(plan.payments.map((p) => p.date)).toEqual(['2026-09-30', '2026-08-05']);
  });

  it('filas de cobro sobre una cuenta que ya tiene cobros hasta el corte: error, no se duplican', () => {
    const plan = planOpeningBalances(
      [account('F1', { paidUpToCutoff: new Decimal(300), payableNow: new Decimal('880.00') })],
      [
        row('F1', { amount: '300', date: '2026-08-20' }),
        row('F1', { amount: '200', date: '2026-09-01' }),
      ],
      options(),
    );
    expect(plan.errors[0]?.message).toMatch(/ya tiene 300.00 registrado en la app/);
    expect(plan.payments).toEqual([]);
  });

  it('un resto de fracciones de céntimo no es deuda (D-377): no registra 0,01', () => {
    const tail = account('F1', {
      netAtCutoff: new Decimal('1180.0001'),
      paidUpToCutoff: new Decimal('1180'),
      payableNow: new Decimal('0.01'),
    });
    expect(planOpeningBalances([tail], [], options({ missing: 'PAID' })).payments).toEqual([]);
    expect(planOpeningBalances([tail], [row('F1', { balance: '0' })], options()).payments).toEqual(
      [],
    );
  });

  it('una fila vacía de un comprobante emitido después del corte no es error', () => {
    const plan = planOpeningBalances(
      [account('F9', { issueDate: '2026-10-02' })],
      [row('F9')],
      options(),
    );
    expect(plan.errors).toEqual([]);
  });

  it('suma por moneda', () => {
    const plan = planOpeningBalances(
      [account('A', { currency: 'PEN' }), account('B', { currency: 'USD' })],
      [row('A', { balance: '180' }), row('B', { balance: '1080' })],
      options(),
    );
    expect(plan.totalsByCurrency).toEqual({ PEN: '1000.00', USD: '100.00' });
    expect(plan.payments.map((p) => p.currency)).toEqual(['PEN', 'USD']);
  });

  it('una fila vacía de un comprobante cuenta como si no apareciera', () => {
    const plan = planOpeningBalances([account('F1')], [row('F1')], options({ missing: 'PAID' }));
    expect(plan.payments[0]?.source).toBe('MISSING_PAID');
  });

  it('lleva el tipo de cambio de la fila en compras', () => {
    const plan = planOpeningBalances(
      [account('F1')],
      [row('F1', { amount: '100', date: '2026-09-01', exchangeRate: ' 3.75 ' })],
      options(),
    );
    expect(plan.payments[0]?.exchangeRate).toBe('3.75');
  });
});

describe('cc61 (D-700, IMP-01/IMP-02 de audit-02): redondeo al céntimo del saldo al corte', () => {
  const supplier = options({ noun: { account: 'compra', payment: 'pago' } });

  it('compra con total 117.9999 y saldo 0: registra 117.99, avisa y no rechaza el lote', () => {
    const plan = planOpeningBalances(
      [
        account('20999 · F001-9', {
          netAtCutoff: new Decimal('117.9999'),
          payableNow: new Decimal('117.99'),
          currency: 'PEN',
        }),
      ],
      [row('20999 · F001-9', { balance: '0' })],
      supplier,
    );
    expect(plan.errors).toEqual([]);
    expect(plan.payments[0]?.amount).toBe('117.99');
    expect(plan.warnings.map((w) => w.message)).toEqual([
      'redondeo al céntimo: el total tiene más de dos decimales (117.9999); se registra 117.99 en vez de 118.00',
    ]);
  });

  it('la misma compra con saldo 18: registra 99.9999 → 100.00 sin aviso', () => {
    const plan = planOpeningBalances(
      [
        account('20999 · F001-9', {
          netAtCutoff: new Decimal('117.9999'),
          payableNow: new Decimal('117.99'),
        }),
      ],
      [row('20999 · F001-9', { balance: '18' })],
      supplier,
    );
    expect(plan.errors).toEqual([]);
    expect(plan.payments[0]?.amount).toBe('100.00');
    expect(plan.warnings).toEqual([]);
  });

  it('comprobante 1180.0001 con saldo 100: registra 1080.00 y el saldo queda en 100.00', () => {
    const plan = planOpeningBalances(
      [
        account('F1', {
          netAtCutoff: new Decimal('1180.0001'),
          payableNow: new Decimal('1180.01'),
        }),
      ],
      [row('F1', { balance: '100' })],
      options(),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.payments[0]?.amount).toBe('1080.00');
    expect(plan.accounts[0]?.balanceAtCutoffAfter).toBe('100.00');
  });

  it('una diferencia real de más de un céntimo sigue rechazando con el mensaje de siempre', () => {
    const plan = planOpeningBalances(
      [
        account('F1', {
          netAtCutoff: new Decimal('1180.0001'),
          payableNow: new Decimal('1000.00'),
        }),
      ],
      [row('F1', { balance: '0' })],
      options(),
    );
    expect(plan.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('habría que registrar 1180.00 y hoy solo se puede 1000.00'),
    ]);
  });

  it('un saldo declarado a dos decimales exactos no se toca aunque falte un céntimo', () => {
    // Sin cola de diezmilésimas no hay redondeo que avisar: un céntimo de diferencia es real.
    const plan = planOpeningBalances(
      [account('F1', { netAtCutoff: new Decimal('1180.00'), payableNow: new Decimal('1179.99') })],
      [row('F1', { balance: '0' })],
      options(),
    );
    expect(plan.errors).toHaveLength(1);
  });

  it('saldo al corte con más de dos decimales: se rechaza como el monto de un cobro', () => {
    const plan = planOpeningBalances(
      [account('F1')],
      [row('F1', { balance: '100.005' })],
      options(),
    );
    expect(plan.errors.map((e) => e.message)).toEqual([
      'saldo al corte con más de dos decimales: «100.005»',
    ]);
  });

  it('un saldo declarado igual a lo debido no registra nada ni da error', () => {
    const plan = planOpeningBalances(
      [account('F1', { netAtCutoff: new Decimal('1180.0001') })],
      [row('F1', { balance: '1180.00' })],
      options(),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.payments).toEqual([]);
  });
});

describe('cc61 (IMP-08 de audit-02): baja en trámite con «pagado al corte»', () => {
  it('no recibe el cobro supuesto: queda pendiente, con aviso', () => {
    const plan = planOpeningBalances(
      [account('F1', { voidPending: true }), account('F2')],
      [],
      options({ missing: 'PAID' }),
    );
    expect(plan.payments.map((p) => p.key)).toEqual(['F2']);
    expect(plan.accounts.find((a) => a.key === 'F1')?.treatment).toBe('MISSING_PENDING');
    expect(plan.warnings.map((w) => w.message)).toEqual([
      'tiene la baja en trámite ante SUNAT: no se le supone el cobro; queda pendiente',
    ]);
  });
});

describe('revisión de cc61 (R-2): empate de medio céntimo', () => {
  it('99.9950 al corte con 100.00 declarado: no registra nada y no rechaza', () => {
    const plan = planOpeningBalances(
      [account('F1', { netAtCutoff: new Decimal('99.9950'), payableNow: new Decimal('100.00') })],
      [row('F1', { balance: '100.00' })],
      options(),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.payments).toEqual([]);
  });
});

describe('revisión de cc61 (IMP-08): baja en trámite con filas en el Excel', () => {
  it('registra lo que dice la fila y avisa', () => {
    const plan = planOpeningBalances(
      [account('F1', { voidPending: true })],
      [row('F1', { balance: '0' })],
      options(),
    );
    expect(plan.payments).toHaveLength(1);
    expect(plan.warnings.map((w) => w.message)).toEqual([
      'tiene la baja en trámite ante SUNAT: si se acepta, este pago quedará sobre un comprobante anulado',
    ]);
  });
});
