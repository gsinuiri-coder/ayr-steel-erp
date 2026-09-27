import { describe, expect, it, vi } from 'vitest';
import { receiveSequentially, summarizeOutcomes } from './receive-batch';

/** D-353 — recibir varias compras: una por una, cada una con su resultado. */

describe('receiveSequentially', () => {
  it('recibe en el orden elegido y una que falla no detiene a las demás', async () => {
    const calls: string[] = [];
    const receive = vi.fn((id: string) => {
      calls.push(id);
      return id === 'b'
        ? Promise.reject(new Error('La compra ya fue recibida'))
        : Promise.resolve({});
    });
    const outcomes = await receiveSequentially(
      [
        { id: 'a', label: 'F001-1' },
        { id: 'b', label: 'F001-2' },
        { id: 'c', label: 'F001-3' },
      ],
      receive,
    );
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(outcomes).toEqual([
      { id: 'a', label: 'F001-1', ok: true, message: 'Recibida' },
      { id: 'b', label: 'F001-2', ok: false, message: 'La compra ya fue recibida' },
      { id: 'c', label: 'F001-3', ok: true, message: 'Recibida' },
    ]);
    expect(summarizeOutcomes(outcomes)).toBe('2 recibidas, 1 con error');
  });

  it('un error que no es Error se nombra igual', async () => {
    const [outcome] = await receiveSequentially([{ id: 'a', label: 'X' }], () =>
      Promise.reject(new Error('')),
    );
    expect(outcome?.ok).toBe(false);
    const [other] = await receiveSequentially([{ id: 'a', label: 'X' }], () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- el caso es justo ese
      Promise.reject('texto'),
    );
    expect(other?.message).toBe('No se pudo recibir');
    expect(summarizeOutcomes([{ id: 'a', label: 'X', ok: true, message: '' }])).toBe('1 recibida');
  });
});
