import { Decimal } from '@ayr/shared';
import {
  addDaysIso,
  LOAD_SHEET_HEADERS,
  reviewBackdatedLoad,
  type LoadContext,
  type Sheets,
} from './backdated-load';

/** cc63: la revisión previa de una carga atrasada, sin base. */
const empty = (): Sheets => ({
  purchases: [],
  sales: [],
  production: [],
  dispatches: [],
  collections: [],
  supplierPayments: [],
});

const ctx = (over: Partial<LoadContext> = {}): LoadContext => ({
  loadDate: '2026-12-01',
  historicalFloor: '2026-08-01',
  kardex: new Map(),
  products: new Set(['COB030ROJO', 'PERFIL-1']),
  coils: new Set(['BOB-001']),
  ...over,
});

const purchase = (over: Record<string, string> = {}) => ({
  'RUC PROVEEDOR': '20100000001',
  'SERIE-NÚMERO': 'F001-1',
  'FECHA DE EMISIÓN': '2026-10-14',
  'FECHA DE RECEPCIÓN': '2026-10-15',
  SKU: 'PERFIL-1',
  CANTIDAD: '100',
  ...over,
});
const sale = (over: Record<string, string> = {}) => ({
  'F. EMISIÓN': '2026-10-20',
  'SERIE - NÚMERO': 'FFA1-1',
  'CÓDIGO PRODUCTO': 'PERFIL-1',
  CANTIDAD: '10',
  'VALOR DE VENTA': '100',
  'PRECIO DE VENTA': '118',
  ...over,
});
const dispatch = (over: Record<string, string> = {}) => ({
  'SERIE - NÚMERO': 'FFA1-1',
  FECHA: '2026-10-21',
  'CÓDIGO PRODUCTO': 'PERFIL-1',
  CANTIDAD: '10',
  ...over,
});

describe('reviewBackdatedLoad (cc63)', () => {
  it('un lote coherente: sin errores, y la entrada atrasada recostea lo posterior', () => {
    const sheets = empty();
    sheets.purchases = [purchase()];
    sheets.sales = [sale()];
    sheets.dispatches = [dispatch()];
    sheets.collections = [{ 'SERIE - NÚMERO': 'FFA1-1', FECHA: '2026-10-25', MONTO: '118' }];
    const kardex = new Map([
      ['PRODUCT:PERFIL-1', [{ date: '2026-11-20', delta: new Decimal('5') }]],
    ]);
    const r = reviewBackdatedLoad(sheets, ctx({ kardex }));
    expect(r.errors).toEqual([]);
    expect(r.movements).toEqual({ planned: 2, rejected: 0 });
    expect(r.recosts.map((x) => [x.item, x.date, x.rowsAfter])).toEqual([
      ['PERFIL-1', '2026-10-15', 1],
      ['PERFIL-1', '2026-10-21', 1],
    ]);
    expect(r.counts.sales).toBe(1);
    expect(r.oldestIssue).toEqual({
      document: 'FFA1-1',
      issueDate: '2026-10-20',
      lastLoadDate: '2027-01-18',
    });
  });

  it('una salida que deja negativo se rechaza con la primera fecha válida, y no entra', () => {
    const sheets = empty();
    sheets.purchases = [purchase({ 'FECHA DE RECEPCIÓN': '2026-10-25', CANTIDAD: '10' })];
    sheets.sales = [sale()];
    sheets.dispatches = [dispatch({ FECHA: '2026-10-21' })];
    const r = reviewBackdatedLoad(sheets, ctx());
    expect(r.movements.rejected).toBe(1);
    expect(r.errors.map((e) => e.message)).toEqual([
      'PERFIL-1: sacar 10.000 el 2026-10-21 deja el kardex en negativo el 2026-10-21 (D-652); la primera fecha válida es 2026-10-25',
    ]);
  });

  it('producción: la bobina nueva sale después de entrar y lo fabricado recostea en cascada', () => {
    const sheets = empty();
    sheets.purchases = [
      purchase({
        SKU: '',
        KG: '5000',
        'CÓDIGO EXTERNO': 'EXT-9',
        'FECHA DE RECEPCIÓN': '2026-10-16',
      }),
    ];
    sheets.sales = [sale({ 'CÓDIGO PRODUCTO': 'COB030ROJO' })];
    sheets.production = [
      {
        'SERIE - NÚMERO': 'FFA1-1',
        FECHA: '2026-10-17',
        'CÓDIGO PRODUCTO': 'COB030ROJO',
        CANTIDAD: '10',
        'CÓDIGO BOBINA': 'EXT-9',
        'KG CONSUMIDOS': '50',
      },
    ];
    sheets.dispatches = [dispatch({ 'CÓDIGO PRODUCTO': 'COB030ROJO', FECHA: '2026-10-18' })];
    const kardex = new Map([
      ['PRODUCT:COB030ROJO', [{ date: '2026-11-05', delta: new Decimal('3') }]],
    ]);
    const r = reviewBackdatedLoad(sheets, ctx({ kardex }));
    expect(r.errors).toEqual([]);
    // La salida de la bobina cuenta lo posterior de la bobina (nada) y de lo fabricado (1 fila).
    expect(r.recosts.find((x) => x.item === 'bobina EXT-9')?.rowsAfter).toBe(1);
  });

  it('una bobina que no entra antes del parte da negativo; una inexistente, error de referencia', () => {
    const sheets = empty();
    sheets.purchases = [
      purchase({
        SKU: '',
        KG: '100',
        'CÓDIGO EXTERNO': 'EXT-1',
        'FECHA DE RECEPCIÓN': '2026-10-20',
      }),
    ];
    sheets.sales = [sale({ 'CÓDIGO PRODUCTO': 'COB030ROJO' })];
    sheets.production = [
      {
        'SERIE - NÚMERO': 'FFA1-1',
        FECHA: '2026-10-18',
        'CÓDIGO PRODUCTO': 'COB030ROJO',
        CANTIDAD: '1',
        'CÓDIGO BOBINA': 'EXT-1',
        'KG CONSUMIDOS': '10',
      },
      {
        'SERIE - NÚMERO': 'FFA1-1',
        FECHA: '2026-10-21',
        'CÓDIGO PRODUCTO': 'COB030ROJO',
        CANTIDAD: '1',
        'CÓDIGO BOBINA': 'NOPE',
        'KG CONSUMIDOS': '10',
      },
    ];
    const messages = reviewBackdatedLoad(sheets, ctx()).errors.map((e) => e.message);
    expect(messages).toContain(
      'bobina EXT-1: sacar 10.000 el 2026-10-18 deja el kardex en negativo el 2026-10-18 (D-652); la primera fecha válida es 2026-10-20',
    );
    expect(messages).toContain('la bobina NOPE no existe ni entra en la hoja de compras');
  });

  it('revisión H-1: si la bobina no alcanza, el parte entero falla y el despacho de lo fabricado también', () => {
    const sheets = empty();
    sheets.purchases = [
      purchase({
        SKU: '',
        KG: '10',
        'CÓDIGO EXTERNO': 'EXT-2',
        'FECHA DE RECEPCIÓN': '2026-10-15',
      }),
    ];
    sheets.sales = [sale({ 'CÓDIGO PRODUCTO': 'COB030ROJO' })];
    sheets.production = [
      {
        'SERIE - NÚMERO': 'FFA1-1',
        FECHA: '2026-10-16',
        'CÓDIGO PRODUCTO': 'COB030ROJO',
        CANTIDAD: '10',
        'CÓDIGO BOBINA': 'EXT-2',
        'KG CONSUMIDOS': '50',
      },
    ];
    sheets.dispatches = [dispatch({ 'CÓDIGO PRODUCTO': 'COB030ROJO', FECHA: '2026-10-17' })];
    const r = reviewBackdatedLoad(sheets, ctx());
    expect(r.movements.rejected).toBe(2);
    expect(r.errors.map((e) => e.sheet)).toEqual(['Producción', 'Despachos']);
  });

  it('revisión H-2 y H-3: producir de más avisa; un valor de venta ilegible es error', () => {
    const sheets = empty();
    sheets.sales = [sale({ 'VALOR DE VENTA': 'abc' })];
    sheets.production = [
      {
        'SERIE - NÚMERO': 'FFA1-1',
        FECHA: '2026-10-21',
        'CÓDIGO PRODUCTO': 'PERFIL-1',
        CANTIDAD: '12',
      },
    ];
    const r = reviewBackdatedLoad(sheets, ctx());
    expect(r.errors.map((e) => e.message)).toContain('valor de venta inválido: «abc»');
    expect(r.warnings.map((w) => w.message)).toContain(
      'FFA1-1 produce 12.000 de PERFIL-1 y vendió 10.000',
    );
  });

  it('autorrevisión: la NC del export se salta, la venta en USD no se compara con soles y la bobina sin código avisa', () => {
    const sheets = empty();
    sheets.purchases = [
      purchase({ 'TIPO DE COMPRA': 'BOBINAS', SKU: '', KG: '100', 'CÓDIGO EXTERNO': '' }),
    ];
    sheets.sales = [
      sale({ 'TIPO COMPROBANTE': 'NOTA DE CRÉDITO', 'SERIE - NÚMERO': 'FC01-1', CANTIDAD: '-1' }),
      sale({ 'SERIE - NÚMERO': 'FFA1-9', MONEDA: 'USD' }),
    ];
    sheets.collections = [{ 'SERIE - NÚMERO': 'FFA1-9', FECHA: '2026-10-25', MONTO: '500' }];
    const r = reviewBackdatedLoad(sheets, ctx());
    expect(r.errors).toEqual([]);
    expect(r.counts.sales).toBe(1);
    expect(r.warnings.map((w) => w.message)).toEqual([
      'bobina sin CÓDIGO EXTERNO: entra, pero la hoja de producción no la puede nombrar ni se revisa su consumo',
      'FC01-1 es una nota de crédito: no entra como venta (se registra aparte)',
    ]);
  });

  it('montos con separadores de miles', () => {
    const sheets = empty();
    sheets.sales = [sale({ 'VALOR DE VENTA': '1,234.50', 'PRECIO DE VENTA': '' })];
    sheets.collections = [{ 'SERIE - NÚMERO': 'FFA1-1', FECHA: '2026-10-25', MONTO: '1.456,71' }];
    expect(reviewBackdatedLoad(sheets, ctx()).errors).toEqual([]);
  });

  it('la ventana de 90 días de la emisión: fuera, error; cerca, aviso', () => {
    const sheets = empty();
    sheets.sales = [
      sale({ 'F. EMISIÓN': '2026-10-14', 'SERIE - NÚMERO': 'FFA1-1' }),
      sale({ 'F. EMISIÓN': '2026-10-25', 'SERIE - NÚMERO': 'FFA1-2' }),
    ];
    const late = reviewBackdatedLoad(sheets, ctx({ loadDate: '2027-01-13' }));
    expect(late.errors.map((e) => e.message)).toEqual([
      'FFA1-1 (emitido el 2026-10-14) ya no se puede registrar: la emisión acepta hasta 90 días atrás (último día: 2027-01-12)',
    ]);
    expect(late.warnings.map((w) => w.message)).toEqual([
      'FFA1-2 (emitido el 2026-10-25) se puede registrar solo hasta el 2027-01-23',
    ]);
    expect(late.oldestIssue?.lastLoadDate).toBe('2027-01-12');
  });

  it('fechas fuera de rango, SKU inexistente, despacho de más y cobro de más', () => {
    const sheets = empty();
    sheets.purchases = [
      purchase({ 'FECHA DE RECEPCIÓN': '2026-12-05' }),
      purchase({ SKU: 'NOPE' }),
    ];
    sheets.sales = [sale(), sale({ 'SERIE - NÚMERO': 'FFA1-2', 'F. EMISIÓN': '2026-07-01' })];
    sheets.dispatches = [dispatch({ CANTIDAD: '11' })];
    sheets.collections = [
      { 'SERIE - NÚMERO': 'FFA1-1', FECHA: '2026-10-19', MONTO: '200' },
      { 'SERIE - NÚMERO': 'FFA1-9', FECHA: '2026-10-25', MONTO: '1' },
    ];
    const r = reviewBackdatedLoad(
      sheets,
      ctx({
        kardex: new Map([['PRODUCT:PERFIL-1', [{ date: '2026-09-01', delta: new Decimal('50') }]]]),
      }),
    );
    const messages = r.errors.map((e) => e.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        'La fecha de recepción 2026-12-05 es posterior a la fecha de carga (2026-12-01)',
        'el SKU NOPE no existe en el catálogo',
        'La fecha de emisión 2026-07-01 es anterior al inicio de la carga histórica (2026-08-01)',
        'FFA1-1 despacha 11.000 de PERFIL-1 y vendió 10.000',
        'FFA1-1 cobra 200.00 y su total es 118.00',
        'FFA1-9 no está en la hoja de ventas',
      ]),
    );
    expect(r.warnings.map((w) => w.message)).toContain(
      'el cobro del 2026-10-19 es anterior a la emisión (2026-10-20)',
    );
  });

  it('un movimiento que recostearía más de 500 filas avisa que quedará pendiente', () => {
    const sheets = empty();
    sheets.purchases = [purchase()];
    const many = Array.from({ length: 501 }, () => ({
      date: '2026-11-01',
      delta: new Decimal('1'),
    }));
    const r = reviewBackdatedLoad(sheets, ctx({ kardex: new Map([['PRODUCT:PERFIL-1', many]]) }));
    expect(r.recosts[0]?.overLimit).toBe(true);
    expect(r.warnings[0]?.message).toContain('quedará pendiente para pnpm recosteo:pendientes');
  });

  it('la plantilla trae las columnas de los importadores de compras y de ventas', () => {
    expect(LOAD_SHEET_HEADERS.purchases).toContain('SERIE-NÚMERO');
    expect(LOAD_SHEET_HEADERS.purchases.at(-1)).toBe('FECHA DE RECEPCIÓN');
    expect(LOAD_SHEET_HEADERS.sales).toContain('SERIE - NÚMERO');
    expect(addDaysIso('2026-10-14', 90)).toBe('2027-01-12');
  });
});

describe('cc64 (D-705): columnas opcionales y drywall', () => {
  const info = new Map([
    ['PERFIL-1', { drywall: false, needsLengths: false }],
    ['COB030ROJO', { drywall: false, needsLengths: true }],
    ['DRY-1', { drywall: true, needsLengths: false }],
  ]);
  const withInfo = (over: Partial<LoadContext> = {}) =>
    ctx({ products: new Set(['PERFIL-1', 'COB030ROJO', 'DRY-1']), productInfo: info, ...over });

  it('una línea a medida exige LARGOS que sumen la cantidad', () => {
    const sheets = empty();
    sheets.sales = [
      sale({ 'CÓDIGO PRODUCTO': 'COB030ROJO', CANTIDAD: '12', 'SERIE - NÚMERO': 'FFA1-1' }),
      sale({
        'CÓDIGO PRODUCTO': 'COB030ROJO',
        CANTIDAD: '12',
        'SERIE - NÚMERO': 'FFA1-2',
        LARGOS: '4,5x2; 3x1',
      }),
      sale({
        'CÓDIGO PRODUCTO': 'COB030ROJO',
        CANTIDAD: '12',
        'SERIE - NÚMERO': 'FFA1-3',
        LARGOS: '4.5 x 2;3x2',
      }),
      sale({
        'CÓDIGO PRODUCTO': 'COB030ROJO',
        CANTIDAD: '12',
        'SERIE - NÚMERO': 'FFA1-4',
        LARGOS: 'doce',
      }),
      sale({ 'SERIE - NÚMERO': 'FFA1-5', LARGOS: '3x1' }),
    ];
    const r = reviewBackdatedLoad(sheets, withInfo());
    // FFA1-2 (4,5 × 2 + 3 × 1 = 12 m) está bien; FFA1-3 suma 15 m.
    expect(r.errors.map((e) => e.message)).toEqual([
      'COB030ROJO es a medida: falta LARGOS (por ejemplo «4.5x10; 3x8», metros x piezas)',
      'LARGOS suman 15.000 m y la cantidad es 12.000',
      'LARGOS inválidos: «doce» (usa metros x piezas, separados por «;»)',
    ]);
    expect(r.warnings.map((w) => w.message)).toContain(
      'PERFIL-1 no lleva largos: la columna LARGOS se ignora',
    );
  });

  it('condición de pago y vencimiento', () => {
    const sheets = empty();
    sheets.sales = [
      sale({
        'SERIE - NÚMERO': 'FFA1-1',
        'CONDICIÓN DE PAGO': 'Crédito',
        VENCIMIENTO: '2026-11-20',
      }),
      sale({
        'SERIE - NÚMERO': 'FFA1-2',
        'CONDICIÓN DE PAGO': 'contado',
        VENCIMIENTO: '2026-11-20',
      }),
      sale({ 'SERIE - NÚMERO': 'FFA1-3', 'CONDICIÓN DE PAGO': 'a 30 días' }),
      sale({ 'SERIE - NÚMERO': 'FFA1-4', VENCIMIENTO: '2026-10-01' }),
    ];
    expect(reviewBackdatedLoad(sheets, withInfo()).errors.map((e) => e.message)).toEqual([
      'una venta al contado no lleva VENCIMIENTO',
      'CONDICIÓN DE PAGO inválida: «a 30 días» (CONTADO o CRÉDITO)',
      'el vencimiento 2026-10-01 es anterior a la emisión 2026-10-20',
    ]);
  });

  it('modalidad del despacho: vacía avisa, entrega exige destino y ubigeo', () => {
    const sheets = empty();
    sheets.purchases = [purchase({ CANTIDAD: '100' })];
    sheets.sales = [sale({ CANTIDAD: '40' })];
    sheets.dispatches = [
      dispatch({ CANTIDAD: '1' }),
      dispatch({ CANTIDAD: '1', MODALIDAD: 'Recojo' }),
      dispatch({ CANTIDAD: '1', MODALIDAD: 'ENTREGA' }),
      dispatch({
        CANTIDAD: '1',
        MODALIDAD: 'entrega',
        'DIRECCIÓN DESTINO': 'Av. Uno 123',
        UBIGEO: '150101',
      }),
      dispatch({ CANTIDAD: '1', MODALIDAD: 'courier' }),
    ];
    const r = reviewBackdatedLoad(sheets, withInfo());
    expect(r.errors.map((e) => [e.row, e.message])).toEqual([
      [4, 'una entrega exige DIRECCIÓN DESTINO'],
      [4, 'una entrega exige UBIGEO de 6 dígitos'],
      [6, 'MODALIDAD inválida: «courier» (RECOJO o ENTREGA)'],
    ]);
    expect(
      r.warnings.filter((w) => w.sheet === 'Despachos').map((w) => [w.row, w.message]),
    ).toEqual([[2, 'sin MODALIDAD: se cargará como recojo']]);
  });

  it('un parte de drywall se carga a mano y no se simula', () => {
    const sheets = empty();
    sheets.sales = [sale({ 'CÓDIGO PRODUCTO': 'DRY-1' })];
    sheets.production = [
      {
        'SERIE - NÚMERO': 'FFA1-1',
        FECHA: '2026-10-21',
        'CÓDIGO PRODUCTO': 'DRY-1',
        CANTIDAD: '10',
      },
    ];
    const r = reviewBackdatedLoad(sheets, withInfo());
    expect(r.movements.planned).toBe(0);
    expect(r.warnings.map((w) => w.message)).toContain(
      'DRY-1 es de drywall: este parte se carga a mano (no se ejecuta ni se simula)',
    );
  });

  it('la simulación carga cada paso por fecha, no en el orden del archivo', () => {
    const sheets = empty();
    sheets.purchases = [
      purchase({ 'FECHA DE RECEPCIÓN': '2026-10-18', CANTIDAD: '5' }),
      purchase({ 'SERIE-NÚMERO': 'F001-2', 'FECHA DE RECEPCIÓN': '2026-10-15', CANTIDAD: '5' }),
    ];
    sheets.sales = [sale()];
    sheets.dispatches = [
      dispatch({ FECHA: '2026-10-19', CANTIDAD: '5', MODALIDAD: 'RECOJO' }),
      dispatch({ FECHA: '2026-10-16', CANTIDAD: '5', MODALIDAD: 'RECOJO' }),
    ];
    const r = reviewBackdatedLoad(sheets, withInfo());
    expect(r.errors).toEqual([]);
    // Por fecha: la compra del 15 no recostea la del 18, ni el despacho del 19 al del 16. Solo el
    // despacho del 16 queda antes de la compra del 18 (las compras van todas primero): 1 fila.
    // En el orden del archivo serían 2 recosteos, uno de 2 filas.
    expect(r.recosts.map((x) => [x.sheet, x.date, x.rowsAfter])).toEqual([
      ['Despachos', '2026-10-16', 1],
    ]);
  });
});
