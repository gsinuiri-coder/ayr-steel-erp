// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { RoofingReportDraftDto } from '@ayr/shared';
import type { AccessoryEdit } from './accessory-blocks';
import {
  accessoryDraftContent,
  accessoryEditFromDrafts,
  accessoryEditMeters,
  LEGACY_ACCESSORY_PREFIX,
  uploadLegacyAccessoryEdits,
} from './accessory-drafts';
import { flushOrder, saveDraftContent, type DraftCall } from './block-drafts';

/**
 * cc41 (D-591): el bloque de accesorio en el borrador del servidor, y la transición desde lo que
 * D-559 dejó en el navegador. Corre en jsdom para usar el `localStorage` de un navegador de verdad.
 */

const ORDER = 'op-1';
const KEY = LEGACY_ACCESSORY_PREFIX + ORDER;

const draft = (
  coilId: string,
  meters: string,
  extra: Partial<RoofingReportDraftDto> = {},
): RoofingReportDraftDto => ({
  id: `d-${coilId}-${meters}`,
  rowNumber: 1,
  coilId,
  coilCode: coilId.toUpperCase(),
  pieces: [],
  meters,
  piecesCount: null,
  theoreticalKg: '0.000',
  consumedKg: null,
  notes: null,
  createdAt: '2026-10-10T00:00:00.000Z',
  outOfTolerance: null,
  ...extra,
});

/** Un borrador de servidor de mentira: guarda lo que le llega, o rechaza las bobinas dadas. */
function fakeServer(reject: readonly string[] = []) {
  const saved: { coilId: string; edit: AccessoryEdit }[] = [];
  const save = (coilId: string, edit: AccessoryEdit) => {
    if (reject.includes(coilId)) return Promise.resolve(false);
    saved.push({ coilId, edit });
    return Promise.resolve(true);
  };
  return { saved, save };
}

function legacy(value: unknown): void {
  window.localStorage.setItem(KEY, JSON.stringify(value));
}

describe('uploadLegacyAccessoryEdits — transición desde el navegador (D-559 → D-591)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('con el borrador del servidor vacío, sube lo escrito en el orden de montaje y borra la clave', async () => {
    legacy({
      c3: { meters: '4', pieces: '', consumedKg: '' },
      c1: { meters: '7', pieces: '2', consumedKg: '30', key: 'k-1' },
    });
    const server = fakeServer();
    const result = await uploadLegacyAccessoryEdits({
      storage: window.localStorage,
      orderId: ORDER,
      coilIds: ['c1', 'c2', 'c3'],
      serverCoilIds: [],
      registeredCoilIds: [],
      save: server.save,
    });
    expect(result).toEqual({ uploaded: ['c1', 'c3'], failed: null, doubtful: [] });
    // Sin la clave del parte de D-559: solo lo escrito.
    expect(server.saved).toEqual([
      { coilId: 'c1', edit: { meters: '7', pieces: '2', consumedKg: '30' } },
      { coilId: 'c3', edit: { meters: '4', pieces: '', consumedKg: '' } },
    ]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('si el servidor ya tiene borrador, gana el servidor: no sube nada y borra la clave', async () => {
    legacy({ c1: { meters: '7', pieces: '', consumedKg: '' } });
    const server = fakeServer();
    const result = await uploadLegacyAccessoryEdits({
      storage: window.localStorage,
      orderId: ORDER,
      coilIds: ['c1'],
      serverCoilIds: ['c1'],
      registeredCoilIds: [],
      save: server.save,
    });
    expect(result).toEqual({ uploaded: [], failed: null, doubtful: [] });
    expect(server.saved).toEqual([]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('un bloque ya registrado (sent), uno vacío o de una bobina que ya no está montada no se sube', async () => {
    legacy({
      c1: { meters: '5', pieces: '', consumedKg: '', sent: true },
      c2: { meters: '', pieces: '', consumedKg: '' },
      gone: { meters: '3', pieces: '', consumedKg: '' },
    });
    const server = fakeServer();
    const result = await uploadLegacyAccessoryEdits({
      storage: window.localStorage,
      orderId: ORDER,
      coilIds: ['c1', 'c2'],
      serverCoilIds: [],
      registeredCoilIds: [],
      save: server.save,
    });
    expect(result).toEqual({ uploaded: [], failed: null, doubtful: [] });
    expect(server.saved).toEqual([]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('si un guardado se rechaza, para ahí; la vez siguiente reintenta solo las bobinas sin fila en el servidor', async () => {
    legacy({
      c1: { meters: '7', pieces: '', consumedKg: '' },
      c2: { meters: '50', pieces: '', consumedKg: '' },
      c3: { meters: '1', pieces: '', consumedKg: '' },
    });
    const server = fakeServer(['c2']);
    const result = await uploadLegacyAccessoryEdits({
      storage: window.localStorage,
      orderId: ORDER,
      coilIds: ['c1', 'c2', 'c3'],
      serverCoilIds: [],
      registeredCoilIds: [],
      save: server.save,
    });
    expect(result).toEqual({ uploaded: ['c1'], failed: 'c2', doubtful: [] });
    // La clave queda marcada como transición empezada, con lo que falta (no se pierde).
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual({
      c2: { meters: '50', pieces: '', consumedKg: '' },
      c3: { meters: '1', pieces: '', consumedKg: '' },
      _cc41EnCurso: true,
    });

    // La vez siguiente, el servidor tiene la fila de c1 (la subió esta transición): no gana entero,
    // se sube lo que falta. c2 ahora pasa.
    const retry = fakeServer();
    const again = await uploadLegacyAccessoryEdits({
      storage: window.localStorage,
      orderId: ORDER,
      coilIds: ['c1', 'c2', 'c3'],
      serverCoilIds: ['c1'],
      registeredCoilIds: [],
      save: retry.save,
    });
    expect(again).toEqual({ uploaded: ['c2', 'c3'], failed: null, doubtful: [] });
    expect(retry.saved.map((s) => s.coilId)).toEqual(['c2', 'c3']);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('en un reintento, una bobina que ya tiene fila en el servidor no se pisa', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ c1: { meters: '3', pieces: '', consumedKg: '' }, _cc41EnCurso: true }),
    );
    const server = fakeServer();
    const result = await uploadLegacyAccessoryEdits({
      storage: window.localStorage,
      orderId: ORDER,
      coilIds: ['c1'],
      serverCoilIds: ['c1'],
      registeredCoilIds: [],
      save: server.save,
    });
    expect(result).toEqual({ uploaded: [], failed: null, doubtful: [] });
    expect(server.saved).toEqual([]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('un parte de D-559 mandado sin respuesta, con la bobina ya registrada, no se sube: queda en duda', async () => {
    legacy({
      c1: { meters: '4', pieces: '', consumedKg: '', key: 'k-1' },
      c2: { meters: '6', pieces: '', consumedKg: '', key: 'k-2' },
    });
    const server = fakeServer();
    const result = await uploadLegacyAccessoryEdits({
      storage: window.localStorage,
      orderId: ORDER,
      coilIds: ['c1', 'c2'],
      serverCoilIds: [],
      registeredCoilIds: ['c1'],
      save: server.save,
    });
    // c2 tenía clave pero su bobina no tiene nada registrado: el parte no entró y se sube.
    expect(result).toEqual({ uploaded: ['c2'], failed: null, doubtful: ['c1'] });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('sin clave, con JSON roto o sin almacenamiento, no hace nada (y el roto se borra)', async () => {
    const server = fakeServer();
    const input = {
      orderId: ORDER,
      coilIds: ['c1'],
      serverCoilIds: [],
      registeredCoilIds: [],
      save: server.save,
    };
    expect(await uploadLegacyAccessoryEdits({ ...input, storage: window.localStorage })).toEqual({
      uploaded: [],
      failed: null,
      doubtful: [],
    });
    window.localStorage.setItem(KEY, '{roto');
    await uploadLegacyAccessoryEdits({ ...input, storage: window.localStorage });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(await uploadLegacyAccessoryEdits({ ...input, storage: null })).toEqual({
      uploaded: [],
      failed: null,
      doubtful: [],
    });
    expect(server.saved).toEqual([]);
  });

  it('las claves de otras órdenes no se tocan', async () => {
    window.localStorage.setItem(`${LEGACY_ACCESSORY_PREFIX}otra`, '{"c9":{"meters":"1"}}');
    legacy({ c1: { meters: '2', pieces: '', consumedKg: '' } });
    await uploadLegacyAccessoryEdits({
      storage: window.localStorage,
      orderId: ORDER,
      coilIds: ['c1'],
      serverCoilIds: [],
      registeredCoilIds: [],
      save: fakeServer().save,
    });
    expect(window.localStorage.getItem(`${LEGACY_ACCESSORY_PREFIX}otra`)).not.toBeNull();
  });
});

describe('accessoryDraftContent', () => {
  it('metros, piezas y kilos al formato del API; vacío es «borrar la fila»', () => {
    expect(accessoryDraftContent({ meters: '7', pieces: '2', consumedKg: '30' })).toEqual({
      ok: true,
      content: { meters: '7.000', piecesCount: 2, consumedKg: '30.000' },
    });
    expect(accessoryDraftContent({ meters: '3.5', pieces: '', consumedKg: '' })).toEqual({
      ok: true,
      content: { meters: '3.500' },
    });
    expect(accessoryDraftContent({ meters: ' ', pieces: '', consumedKg: '' })).toEqual({
      ok: true,
      content: null,
    });
  });

  it('lo mal escrito no se guarda y dice por qué', () => {
    const reason = (edit: AccessoryEdit) => {
      const r = accessoryDraftContent(edit);
      return r.ok ? null : r.reason;
    };
    expect(reason({ meters: '', pieces: '2', consumedKg: '' })).toMatch(/metros de esta bobina/);
    expect(reason({ meters: '1.2345', pieces: '', consumedKg: '' })).toMatch(/tres decimales/);
    expect(reason({ meters: '0', pieces: '', consumedKg: '' })).toMatch(/mayores a cero/);
    expect(reason({ meters: '1', pieces: '1.5', consumedKg: '' })).toMatch(/entero/);
    expect(reason({ meters: '1', pieces: '', consumedKg: '-3' })).toMatch(/kilos/);
  });

  it('accessoryEditMeters cuenta lo escrito, y cero si no se puede contar', () => {
    expect(accessoryEditMeters({ meters: '2.5', pieces: '', consumedKg: '' })).toBe('2.500');
    expect(accessoryEditMeters({ meters: 'x', pieces: '', consumedKg: '' })).toBe('0');
    expect(accessoryEditMeters(undefined)).toBe('0');
  });
});

describe('accessoryEditFromDrafts y el guardado de un bloque', () => {
  it('lee lo guardado sin ceros de más, y suma dos filas de la misma bobina (D-548)', () => {
    expect(accessoryEditFromDrafts([])).toBeNull();
    expect(
      accessoryEditFromDrafts([draft('c1', '7.000', { piecesCount: 2, consumedKg: '30.000' })]),
    ).toEqual({ meters: '7', pieces: '2', consumedKg: '30' });
    expect(
      accessoryEditFromDrafts([draft('c1', '2.500', { piecesCount: 1 }), draft('c1', '1.000')]),
    ).toEqual({ meters: '3.5', pieces: '1', consumedKg: '' });
  });

  it('un bloque de accesorio sin fila da de alta una con sus metros y la clave de su contenido', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const call: DraftCall = (path, init) => {
      calls.push({ path, method: init.method, body: init.body });
      return Promise.resolve([]);
    };
    await saveDraftContent({
      orderId: ORDER,
      coilId: 'c1',
      content: { meters: '7.000', piecesCount: 2 },
      existing: [],
      call,
      keyFor: () => 'clave',
    });
    expect(calls).toEqual([
      {
        path: `/production/roofing/${ORDER}/drafts`,
        method: 'POST',
        body: { coilId: 'c1', meters: '7.000', piecesCount: 2, idempotencyKey: 'clave' },
      },
    ]);
  });

  it('flushOrder mide lo guardado de un accesorio por sus metros: primero lo que baja', () => {
    const edits: Record<string, AccessoryEdit> = {
      up: { meters: '9', pieces: '', consumedKg: '' },
      down: { meters: '1', pieces: '', consumedKg: '' },
    };
    const saved = [draft('up', '5.000'), draft('down', '6.000')];
    expect(flushOrder(['up', 'down'], edits, saved, accessoryEditMeters)).toEqual(['down', 'up']);
  });
});
