import { afterCursorWhere, decodeCursor, encodeCursor, sourceRank } from './audit-cursor';

describe('audit-cursor (D-218/RF-S2)', () => {
  it('encodeCursor/decodeCursor son inversas', () => {
    const c = { occurredAt: '2026-09-16T10:00:00.000Z', source: 'audit_log' as const, id: '42' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('decodeCursor rechaza un cursor con forma inválida', () => {
    expect(() => decodeCursor('no-es-base64url-json-valido')).toThrow(
      'Cursor de auditoría inválido',
    );
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow();
  });

  it('decodeCursor rechaza una fuente desconocida', () => {
    const raw = Buffer.from(
      JSON.stringify({ occurredAt: '2026-09-16T10:00:00.000Z', source: 'no_existe', id: '1' }),
    ).toString('base64url');
    expect(() => decodeCursor(raw)).toThrow('Cursor de auditoría inválido');
  });

  it('decodeCursor rechaza un id no numérico para audit_log (revienta BigInt() más abajo)', () => {
    const raw = Buffer.from(
      JSON.stringify({
        occurredAt: '2026-09-16T10:00:00.000Z',
        source: 'audit_log',
        id: 'no-es-un-bigint',
      }),
    ).toString('base64url');
    expect(() => decodeCursor(raw)).toThrow('Cursor de auditoría inválido');
  });

  it('decodeCursor acepta un id no numérico para una fuente de UUID', () => {
    const c = {
      occurredAt: '2026-09-16T10:00:00.000Z',
      source: 'sales_price_change' as const,
      id: 'c1a2b3c4-d5e6-4f78-9012-3456789abcde',
    };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('sin cursor, no hay condición de borde', () => {
    expect(afterCursorWhere(sourceRank('audit_log'), null)).toBeNull();
  });

  it('rank mayor que el del cursor: borde inclusivo (una fila empatada en el tiempo va después)', () => {
    const cursor = {
      occurredAt: '2026-09-16T10:00:00.000Z',
      source: 'audit_log' as const,
      id: '1',
    };
    const boundary = afterCursorWhere(sourceRank('sales_price_change'), cursor);
    expect(boundary).toEqual({ mode: 'lte', occurredAt: cursor.occurredAt });
  });

  it('rank menor que el del cursor: borde estricto (lo empatado ya se mostró)', () => {
    const cursor = {
      occurredAt: '2026-09-16T10:00:00.000Z',
      source: 'fiscal_document_issue_date_change' as const,
      id: '1',
    };
    const boundary = afterCursorWhere(sourceRank('audit_log'), cursor);
    expect(boundary).toEqual({ mode: 'lt', occurredAt: cursor.occurredAt });
  });

  it('misma fuente que el cursor: desempate por id', () => {
    const cursor = {
      occurredAt: '2026-09-16T10:00:00.000Z',
      source: 'audit_log' as const,
      id: '7',
    };
    const boundary = afterCursorWhere(sourceRank('audit_log'), cursor);
    expect(boundary).toEqual({ mode: 'same-source', occurredAt: cursor.occurredAt, id: '7' });
  });
});
