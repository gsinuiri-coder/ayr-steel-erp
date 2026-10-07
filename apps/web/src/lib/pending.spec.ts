import { describe, expect, it } from 'vitest';
import { pendingRows, type PendingSources } from './pending';

const NONE: PendingSources = {
  unacceptedDocuments: null,
  shortfallOrders: null,
  belowFloorPrices: null,
  readyOrders: null,
  temporaryReservations: null,
  emittedQuotations: null,
  productionQueue: null,
};

/** cc31: la campana de pendientes (ESPEC §8). */
describe('campana de pendientes', () => {
  it('sin pendientes no hay filas', () => {
    expect(pendingRows(NONE, '2026-10-07', false)).toEqual([]);
    expect(
      pendingRows(
        { ...NONE, unacceptedDocuments: 0, readyOrders: 0, shortfallOrders: [] },
        '2026-10-07',
        false,
      ),
    ).toEqual([]);
  });

  it('el administrador ve todo, cada fila con su lista filtrada', () => {
    const rows = pendingRows(
      {
        ...NONE,
        unacceptedDocuments: 2,
        shortfallOrders: [
          { orderCode: 'PED-000058' },
          { orderCode: 'PED-000060' },
          { orderCode: 'PED-000061' },
        ],
        belowFloorPrices: 5,
        readyOrders: 4,
        productionQueue: 6,
      },
      '2026-10-07',
      false,
    );
    expect(rows.map((r) => [r.title, r.href])).toEqual([
      ['2 comprobantes sin aceptar por SUNAT', '/comprobantes?status=ISSUED,SEND_ERROR'],
      ['3 pedidos confirmados con faltante de material', '/'],
      ['5 precios de lista bajo el piso', '/'],
      ['4 pedidos listos para despachar', '/pedidos?stage=READY'],
      ['6 órdenes esperan producción', '/planta'],
    ]);
    expect(rows[1]?.detail).toBe('PED-000058, PED-000060 y 1 más');
  });

  it('el vendedor ve lo suyo, en singular cuando es uno', () => {
    const rows = pendingRows({ ...NONE, readyOrders: 1 }, '2026-10-07', true);
    expect(rows[0]?.title).toBe('1 pedido tuyo listo para despachar');
    expect(pendingRows({ ...NONE, readyOrders: 2 }, '2026-10-07', true)[0]?.title).toBe(
      '2 pedidos tuyos listos para despachar',
    );
  });

  it('las reservas temporales cuentan solo si vencen hoy en Lima', () => {
    const rows = pendingRows(
      {
        ...NONE,
        temporaryReservations: [
          // 23:00 UTC del 7 son las 18:00 del 7 en Lima: vence hoy.
          { quotationCode: 'COT-000150', expiresAt: '2026-10-07T23:00:00.000Z' },
          // 06:00 UTC del 8 es la 01:00 del 8 en Lima: mañana.
          { quotationCode: 'COT-000151', expiresAt: '2026-10-08T06:00:00.000Z' },
        ],
      },
      '2026-10-07',
      true,
    );
    expect(rows).toEqual([
      {
        key: 'reservations',
        title: '1 reserva temporal vence hoy',
        detail: 'COT-000150 · a las 18:00',
        href: '/reservas-temporales',
      },
    ]);
  });

  it('las cotizaciones por vencer son las de los próximos 7 días', () => {
    const rows = pendingRows(
      {
        ...NONE,
        emittedQuotations: [
          { validUntil: '2026-10-08' },
          { validUntil: '2026-10-14' },
          { validUntil: '2026-10-15' },
          { validUntil: '2026-10-06' },
          { validUntil: null },
        ],
      },
      '2026-10-07',
      true,
    );
    expect(rows).toEqual([
      {
        key: 'quotations',
        title: '2 cotizaciones tuyas vencen esta semana',
        detail: 'La primera vence mañana',
        href: '/cotizaciones?status=EMITTED',
      },
    ]);
  });
});
