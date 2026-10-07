import { describe, expect, it } from 'vitest';
import { composeReason, OTHER_REASON } from './reasons';

/** cc31: el motivo de lista viaja como el texto de siempre (ESPEC §6). */
describe('motivo de un diálogo de operación', () => {
  it('el motivo solo, o con su detalle', () => {
    expect(composeReason('Borde dañado', '')).toBe('Borde dañado');
    expect(composeReason('Borde dañado', ' golpe de montacargas ')).toBe(
      'Borde dañado — golpe de montacargas',
    );
  });

  it('«Otro» es el detalle, y sin motivo elegido no hay texto', () => {
    expect(composeReason(OTHER_REASON, 'se cayó del puente grúa')).toBe('se cayó del puente grúa');
    expect(composeReason(OTHER_REASON, '')).toBe('');
    expect(composeReason('', 'algo')).toBe('');
  });
});
