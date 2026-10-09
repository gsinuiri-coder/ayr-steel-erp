import { describe, expect, it } from 'vitest';
import type { RoofingReportDraftDto } from '@ayr/shared';
import {
  blockPayload,
  editMeters,
  flushOrder,
  saveBlockDraft,
  saveErrorTarget,
  type DraftCall,
} from './block-drafts';

/** cc35 (ESPEC §1): el guardado de un bloque del modelo M en el borrador de la orden (D-191). */

const draft = (
  id: string,
  coilId: string,
  rowNumber: number,
  pieces: { lengthMm: string; qty: number }[],
): RoofingReportDraftDto => ({
  id,
  rowNumber,
  coilId,
  coilCode: coilId.toUpperCase(),
  pieces: pieces.map((p, i) => ({ lineNumber: i + 1, ...p })),
  meters: '0.000',
  theoreticalKg: '0.000',
  consumedKg: null,
  notes: null,
  createdAt: '2026-10-09T00:00:00.000Z',
  outOfTolerance: null,
});

function recorder() {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const call: DraftCall = (path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    return Promise.resolve([draft('nuevo', 'a', 1, [])]);
  };
  return { calls, call };
}

describe('blockPayload', () => {
  it('convierte los cortes y los kilos; vacío es «borrar la fila»', () => {
    const ok = blockPayload({
      rows: [
        { lengthM: '4.00', qty: '3' },
        { lengthM: '', qty: '' },
      ],
      consumedKg: '50',
    });
    expect(ok).toEqual({
      ok: true,
      pieces: [{ lineNumber: 1, lengthMm: '4000.00', qty: 3 }],
      consumedKg: '50.000',
      empty: false,
    });
    expect(blockPayload({ rows: [], consumedKg: '' })).toEqual({
      ok: true,
      pieces: [],
      consumedKg: null,
      empty: true,
    });
  });

  it('kilos sin cortes, cortes mal escritos o kilos mal escritos no se guardan', () => {
    expect(blockPayload({ rows: [], consumedKg: '3' }).ok).toBe(false);
    expect(blockPayload({ rows: [{ lengthM: '4', qty: '2.5' }], consumedKg: '' }).ok).toBe(false);
    expect(blockPayload({ rows: [{ lengthM: '4', qty: '2' }], consumedKg: '1,5' }).ok).toBe(false);
  });

  it('editMeters cuenta lo escrito, y cero si no se puede contar', () => {
    expect(editMeters({ rows: [{ lengthM: '4', qty: '3' }], consumedKg: '' })).toBe('12.000');
    expect(editMeters({ rows: [{ lengthM: 'x', qty: '3' }], consumedKg: '' })).toBe('0');
    expect(editMeters(undefined)).toBe('0');
  });
});

describe('saveBlockDraft', () => {
  const payload = (
    pieces: { lengthMm: string; qty: number }[],
    consumedKg: string | null = null,
  ) => ({
    ok: true as const,
    pieces: pieces.map((p, i) => ({ lineNumber: i + 1, ...p })),
    consumedKg,
    empty: pieces.length === 0,
  });

  it('una bobina sin fila da de alta una, con la clave de su contenido', async () => {
    const { calls, call } = recorder();
    const sent: string[] = [];
    await saveBlockDraft({
      orderId: 'op',
      coilId: 'a',
      payload: payload([{ lengthMm: '4000.00', qty: 3 }], '20.000'),
      existing: [],
      call,
      keyFor: (fp) => `clave:${fp}`,
      onSent: (fp) => sent.push(fp),
    });
    expect(calls).toHaveLength(1);
    const [post] = calls;
    expect(post?.method).toBe('POST');
    expect(post?.path).toBe('/production/roofing/op/drafts');
    expect(post?.body).toMatchObject({
      coilId: 'a',
      pieces: [{ lengthMm: '4000.00', qty: 3 }],
      consumedKg: '20.000',
    });
    expect((post?.body as { idempotencyKey: string } | undefined)?.idempotencyKey).toMatch(
      /^clave:a:/,
    );
    expect(sent).toHaveLength(1);
  });

  it('una bobina con dos filas viejas corrige la primera y quita la otra', async () => {
    const { calls, call } = recorder();
    await saveBlockDraft({
      orderId: 'op',
      coilId: 'a',
      payload: payload([{ lengthMm: '4000.00', qty: 7 }]),
      existing: [draft('d1', 'a', 1, []), draft('d2', 'a', 2, [])],
      call,
      keyFor: () => 'k',
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /production/roofing/op/drafts/d2',
      'PUT /production/roofing/op/drafts/d1',
    ]);
  });

  it('un bloque vaciado borra sus filas; sin filas no manda nada', async () => {
    const { calls, call } = recorder();
    const empty = payload([]);
    await saveBlockDraft({
      orderId: 'op',
      coilId: 'a',
      payload: empty,
      existing: [draft('d1', 'a', 1, [])],
      call,
      keyFor: () => 'k',
    });
    expect(calls.map((c) => c.method)).toEqual(['DELETE']);
    const nothing = await saveBlockDraft({
      orderId: 'op',
      coilId: 'a',
      payload: empty,
      existing: [],
      call,
      keyFor: () => 'k',
    });
    expect(nothing).toBeNull();
  });
});

describe('flushOrder y saveErrorTarget', () => {
  it('guarda primero lo que baja de metros (el tope del plan mide todo el borrador)', () => {
    const saved = [
      draft('d1', 'a', 1, [{ lengthMm: '4000.00', qty: 10 }]),
      draft('d2', 'b', 2, [{ lengthMm: '4000.00', qty: 2 }]),
    ];
    const edits = {
      a: { rows: [{ lengthM: '4', qty: '4' }], consumedKg: '' }, // baja 24 m
      b: { rows: [{ lengthM: '4', qty: '8' }], consumedKg: '' }, // sube 24 m
    };
    expect(flushOrder(['b', 'a', 'c'], edits, saved)).toEqual(['a', 'b']);
  });

  it('un «Fila N» de otra bobina va a su bloque; si no, al propio', () => {
    const drafts = [
      { rowNumber: 1, coilId: 'a' },
      { rowNumber: 2, coilId: 'b' },
    ];
    expect(saveErrorTarget('Fila 2: no entra', 'a', drafts)).toEqual({
      coilId: 'b',
      message: 'no entra',
    });
    expect(saveErrorTarget('El plan ya está cubierto', 'a', drafts)).toEqual({
      coilId: 'a',
      message: 'El plan ya está cubierto',
    });
  });
});
