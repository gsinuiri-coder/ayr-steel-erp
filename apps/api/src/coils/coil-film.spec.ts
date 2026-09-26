import { CoilStatus } from '@prisma/client';
import {
  classifyBackfill,
  compareFilmEvents,
  filmStateFromEvents,
  lastFilmEvent,
  monthEndTable,
  resealBlocker,
  type BackfillFacts,
  type FilmEventLike,
  type ResealFacts,
} from './coil-film';

/**
 * D-328 — las cuatro reglas del film, sin base de datos: derivar el estado de los eventos,
 * decidir cuándo se puede volver a sellar, cortar el reporte mensual por fin de mes y clasificar
 * el backfill. Son las que el dueño fijó; un cambio en cualquiera tiene que romper una de acá.
 */

let seq = 0;
function ev(
  type: FilmEventLike['type'],
  operationDate: string,
  extra: Partial<FilmEventLike> = {},
): FilmEventLike {
  seq += 1;
  return {
    id: `e${String(seq).padStart(4, '0')}`,
    type,
    source: type === 'OPENED' ? 'MANUAL' : 'MANUAL',
    operationDate,
    at: new Date(`${operationDate}T12:00:00Z`),
    ...extra,
  };
}

describe('derivación del estado del film', () => {
  it('sin eventos está sellada', () => {
    expect(filmStateFromEvents([])).toBe('SEALED');
  });

  it('el último evento manda: abrir → abierta; abrir y volver a sellar → sellada', () => {
    const open = ev('OPENED', '2026-09-01');
    const reseal = ev('RESEALED', '2026-09-02');
    expect(filmStateFromEvents([open])).toBe('OPENED');
    expect(filmStateFromEvents([open, reseal])).toBe('SEALED');
    expect(filmStateFromEvents([reseal, open])).toBe('SEALED'); // el orden del arreglo no importa
    expect(filmStateFromEvents([open, reseal, ev('OPENED', '2026-09-03')])).toBe('OPENED');
  });

  it('con corte de fecha ignora lo posterior: el reporte de agosto no ve la apertura de septiembre', () => {
    const open = ev('OPENED', '2026-09-05');
    expect(filmStateFromEvents([open], '2026-08-31')).toBe('SEALED');
    expect(filmStateFromEvents([open], '2026-09-05')).toBe('OPENED');
    expect(lastFilmEvent([open], '2026-08-31')).toBeNull();
  });

  it('el mismo día desempata por instante de grabación y luego por id', () => {
    const a = ev('OPENED', '2026-09-05', { at: new Date('2026-09-05T10:00:00Z') });
    const b = ev('RESEALED', '2026-09-05', { at: new Date('2026-09-05T11:00:00Z') });
    expect(filmStateFromEvents([a, b])).toBe('SEALED');
    const c = ev('OPENED', '2026-09-05', { at: b.at, id: 'zzz' });
    expect(compareFilmEvents(b, c)).toBeLessThan(0);
    expect(compareFilmEvents(c, b)).toBeGreaterThan(0);
    expect(compareFilmEvents(c, c)).toBe(0);
  });
});

describe('volver a sellar (resealBlocker)', () => {
  const base: ResealFacts = {
    status: CoilStatus.OPEN,
    film: 'OPENED',
    lastOpen: { source: 'MANUAL', at: new Date('2026-09-10T10:00:00Z') },
    outflows: [],
    liveOrderCodes: [],
  };

  it('una bobina abierta a mano, sin salidas y sin OP, se puede volver a sellar', () => {
    expect(resealBlocker(base)).toBeNull();
  });

  it('una salida VIVA posterior a la apertura lo impide y nombra el movimiento', () => {
    const msg = resealBlocker({
      ...base,
      outflows: [
        {
          refType: 'PRODUCTION',
          operationDate: '2026-09-11',
          at: new Date('2026-09-11T09:00:00Z'),
        },
      ],
    });
    expect(msg).toContain('una producción');
    expect(msg).toContain('2026-09-11');
  });

  it.each([
    ['PRODUCTION', 'una producción'],
    ['SCRAP', 'una merma'],
    ['SPLIT', 'un partido'],
    ['CUTTING', 'un corte'],
  ])('%s cuenta como usar la bobina', (refType, label) => {
    const msg = resealBlocker({
      ...base,
      outflows: [{ refType, operationDate: '2026-09-11', at: new Date('2026-09-11T09:00:00Z') }],
    });
    expect(msg).toContain(label);
  });

  it('una venta entera o un ajuste de cierre NO cuentan como usar', () => {
    expect(
      resealBlocker({
        ...base,
        outflows: [
          { refType: 'SALE', operationDate: '2026-09-11', at: new Date('2026-09-11T09:00:00Z') },
          {
            refType: 'CLOSE_ADJUSTMENT',
            operationDate: '2026-09-11',
            at: new Date('2026-09-11T09:00:00Z'),
          },
        ],
      }),
    ).toBeNull();
  });

  it('una salida viva ANTERIOR a la apertura registrada también lo impide (usada antes de tener film)', () => {
    // Revisión independiente, B-3: una bobina usada en agosto, cuyo primer evento se registró
    // después (el backfill no había corrido), no puede pasar por sellada.
    const msg = resealBlocker({
      ...base,
      outflows: [
        { refType: 'SCRAP', operationDate: '2026-08-01', at: new Date('2026-08-01T09:00:00Z') },
      ],
    });
    expect(msg).toContain('una merma del 2026-08-01');
  });

  it('una salida anulada ya no está en la lista: la bobina se puede volver a sellar', () => {
    // `loadResealFacts` solo trae salidas vivas; sin ellas, nada bloquea.
    expect(resealBlocker({ ...base, outflows: [] })).toBeNull();
  });

  it('una salida en el mismo instante de la apertura sí cuenta (abrir y mermar van juntos)', () => {
    const at = new Date('2026-09-10T10:00:00Z');
    expect(
      resealBlocker({
        ...base,
        outflows: [{ refType: 'SCRAP', operationDate: '2026-09-10', at }],
      }),
    ).toContain('una merma');
  });

  it('una apertura deducida por el backfill cuenta TODA salida viva, sin comparar instantes', () => {
    const msg = resealBlocker({
      ...base,
      // El backfill grabó su evento después de las salidas que lo motivaron.
      lastOpen: { source: 'BACKFILL', at: new Date('2026-09-27T00:00:00Z') },
      outflows: [
        {
          refType: 'PRODUCTION',
          operationDate: '2026-09-02',
          at: new Date('2026-09-02T09:00:00Z'),
        },
      ],
    });
    expect(msg).toContain('una producción');
  });

  it('montada en una OP viva lo impide y nombra la OP', () => {
    expect(resealBlocker({ ...base, liveOrderCodes: ['OP-000123', 'OP-000124'] })).toBe(
      'La bobina está montada en OP-000123, OP-000124: libérala antes de volver a sellar',
    );
  });

  it('nació abierta (hija de partido, fleje de corte): no tiene film que volver a poner', () => {
    expect(resealBlocker({ ...base, lastOpen: { source: 'BIRTH', at: new Date() } })).toContain(
      'nació abierta',
    );
  });

  it('ya sellada, terminada, anulada o en corte: no', () => {
    expect(resealBlocker({ ...base, film: 'SEALED' })).toBe('La bobina ya está sellada');
    expect(resealBlocker({ ...base, status: CoilStatus.CLOSED })).toContain('terminada');
    expect(resealBlocker({ ...base, status: CoilStatus.CANCELLED })).toContain('anulada');
    expect(resealBlocker({ ...base, status: CoilStatus.IN_THIRD_PARTY })).toContain(
      'cancelar el envío',
    );
  });

  it('sin historial de apertura (columna abierta sin evento) igual cuenta todas las salidas', () => {
    const msg = resealBlocker({
      ...base,
      lastOpen: null,
      outflows: [
        { refType: 'SPLIT', operationDate: '2026-08-01', at: new Date('2026-08-01T09:00:00Z') },
      ],
    });
    expect(msg).toContain('un partido');
  });
});

describe('reporte mensual: en qué tabla va cada bobina (monthEndTable)', () => {
  it('sin eventos hasta fin de mes: sellada', () => {
    expect(
      monthEndTable({ status: CoilStatus.OPEN, lastEventType: null, closingKg: '5000.000' }),
    ).toBe('SEALED');
  });

  it('último evento OPENED hasta fin de mes: abierta; RESEALED: sellada', () => {
    expect(
      monthEndTable({ status: CoilStatus.OPEN, lastEventType: 'OPENED', closingKg: '800.000' }),
    ).toBe('OPENED');
    expect(
      monthEndTable({ status: CoilStatus.OPEN, lastEventType: 'RESEALED', closingKg: '800.000' }),
    ).toBe('SEALED');
  });

  it('terminada con saldo final 0 va a «Abiertas» aunque nunca tuviera un evento', () => {
    expect(
      monthEndTable({ status: CoilStatus.CLOSED, lastEventType: null, closingKg: '0.000' }),
    ).toBe('OPENED');
    expect(
      monthEndTable({ status: CoilStatus.CLOSED, lastEventType: 'RESEALED', closingKg: '-0.000' }),
    ).toBe('OPENED');
  });

  it('terminada HOY pero con saldo a fin de ese mes se ubica por su film de entonces', () => {
    // Vendida entera en octubre: al 30 de septiembre seguía sellada y con saldo.
    expect(
      monthEndTable({ status: CoilStatus.CLOSED, lastEventType: null, closingKg: '5000.000' }),
    ).toBe('SEALED');
  });

  it('un saldo distinto de cero nunca se confunde con cero', () => {
    expect(
      monthEndTable({ status: CoilStatus.CLOSED, lastEventType: null, closingKg: '0.001' }),
    ).toBe('SEALED');
    expect(
      monthEndTable({ status: CoilStatus.CLOSED, lastEventType: null, closingKg: '10.000' }),
    ).toBe('SEALED');
  });

  it('una vigente con saldo 0 se ubica por su film, no por el saldo', () => {
    expect(
      monthEndTable({ status: CoilStatus.OPEN, lastEventType: 'OPENED', closingKg: '0.000' }),
    ).toBe('OPENED');
  });
});

describe('backfill (classifyBackfill)', () => {
  const base: BackfillFacts = {
    status: CoilStatus.OPEN,
    bornOpen: false,
    operationDate: '2026-08-01',
    outflows: [],
    sentToCuttingOn: null,
    mountedOn: null,
    hasEvents: false,
  };

  it('sin ninguna salida ni uso: queda sellada, sin evento', () => {
    expect(classifyBackfill(base)).toEqual({ action: 'KEEP', reason: 'NO_USE' });
  });

  it('con salida de producción: se abre, fechada en LA PRIMERA salida', () => {
    const d = classifyBackfill({
      ...base,
      outflows: [
        { refType: 'PRODUCTION', operationDate: '2026-09-10' },
        { refType: 'SCRAP', operationDate: '2026-08-20' },
        { refType: 'PRODUCTION', operationDate: '2026-09-15' },
      ],
    });
    expect(d).toEqual({
      action: 'OPEN',
      reason: 'OUTFLOW',
      operationDate: '2026-08-20',
      source: 'BACKFILL',
    });
  });

  it.each(['PRODUCTION', 'SCRAP', 'SPLIT', 'CUTTING'])('la salida %s abre la bobina', (refType) => {
    expect(
      classifyBackfill({ ...base, outflows: [{ refType, operationDate: '2026-09-01' }] }).action,
    ).toBe('OPEN');
  });

  it('terminada cuya única salida es una venta: sin evento (ONLY_SALE)', () => {
    expect(
      classifyBackfill({
        ...base,
        status: CoilStatus.CLOSED,
        outflows: [{ refType: 'SALE', operationDate: '2026-09-01' }],
      }),
    ).toEqual({ action: 'KEEP', reason: 'ONLY_SALE' });
  });

  it('vigente con una venta y nada más: sin evento y sin el motivo ONLY_SALE', () => {
    expect(
      classifyBackfill({ ...base, outflows: [{ refType: 'SALE', operationDate: '2026-09-01' }] }),
    ).toEqual({ action: 'KEEP', reason: 'NO_USE' });
  });

  it('terminada que además se produjo: se abre (la venta no la libra)', () => {
    const d = classifyBackfill({
      ...base,
      status: CoilStatus.CLOSED,
      outflows: [
        { refType: 'PRODUCTION', operationDate: '2026-08-15' },
        { refType: 'SALE', operationDate: '2026-09-01' },
      ],
    });
    expect(d.action).toBe('OPEN');
    expect(d.operationDate).toBe('2026-08-15');
  });

  it('nació abierta (hija de partido / fleje): se abre el día de su alta con fuente BIRTH', () => {
    expect(classifyBackfill({ ...base, bornOpen: true })).toEqual({
      action: 'OPEN',
      reason: 'BORN_OPEN',
      operationDate: '2026-08-01',
      source: 'BIRTH',
    });
  });

  it('enviada a corte o montada en una OP viva: se abre el día del hecho', () => {
    expect(classifyBackfill({ ...base, sentToCuttingOn: '2026-09-05' })).toMatchObject({
      action: 'OPEN',
      reason: 'IN_CUTTING',
      operationDate: '2026-09-05',
    });
    expect(classifyBackfill({ ...base, mountedOn: '2026-09-07' })).toMatchObject({
      action: 'OPEN',
      reason: 'MOUNTED',
      operationDate: '2026-09-07',
    });
  });

  it('con varias evidencias gana la más temprana', () => {
    expect(
      classifyBackfill({
        ...base,
        mountedOn: '2026-09-07',
        sentToCuttingOn: '2026-09-05',
        outflows: [{ refType: 'SCRAP', operationDate: '2026-09-09' }],
      }),
    ).toMatchObject({ reason: 'IN_CUTTING', operationDate: '2026-09-05' });
  });

  it('sin ningún candidato (arreglo vacío) devuelve KEEP y no revienta al elegir la evidencia', () => {
    // Nada de uso, nada enviado, nada montado, sin salidas: el arreglo de candidatos queda vacío.
    expect(() => classifyBackfill(base)).not.toThrow();
    expect(classifyBackfill({ ...base, outflows: [] })).toEqual({
      action: 'KEEP',
      reason: 'NO_USE',
    });
    // Con una sola evidencia, el `reduce` arranca en ella y la devuelve.
    expect(classifyBackfill({ ...base, mountedOn: '2026-09-07' })).toMatchObject({
      action: 'OPEN',
      operationDate: '2026-09-07',
    });
  });

  it('es idempotente: una bobina que ya tiene eventos no se toca', () => {
    expect(
      classifyBackfill({
        ...base,
        hasEvents: true,
        outflows: [{ refType: 'PRODUCTION', operationDate: '2026-09-10' }],
      }),
    ).toEqual({ action: 'KEEP', reason: 'HAS_EVENTS' });
  });
});
