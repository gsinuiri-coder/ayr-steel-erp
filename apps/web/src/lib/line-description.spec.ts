import { describe, expect, it } from 'vitest';
import {
  descriptionFromStored,
  descriptionToSend,
  MAX_LINE_DESCRIPTION,
} from './line-description';

/**
 * D-283: la descripción de una línea arranca con el nombre del producto y se puede editar. Solo
 * viaja si se editó; los largos de una línea a medida (D-083) se siguen agregando solos.
 */
describe('line-description', () => {
  it('lo guardado igual al nombre, con o sin largos, es la descripción por defecto', () => {
    expect(descriptionFromStored('Teja roja', 'Teja roja', '')).toEqual({
      description: 'Teja roja',
      descriptionEdited: false,
    });
    expect(descriptionFromStored('Teja roja (2 × 4.20 m)', 'Teja roja', '2 × 4.20 m')).toEqual({
      description: 'Teja roja',
      descriptionEdited: false,
    });
  });

  it('lo guardado distinto se reconoce como editado, sin repetir los largos', () => {
    expect(
      descriptionFromStored('Cobertura techo norte (2 × 4.20 m)', 'Teja roja', '2 × 4.20 m'),
    ).toEqual({ description: 'Cobertura techo norte', descriptionEdited: true });
  });

  it('sin editar, vacía o igual al nombre no viaja: manda el API', () => {
    expect(descriptionToSend({ description: 'x', descriptionEdited: false }, 'Teja', '')).toEqual(
      { ok: true, value: undefined },
    );
    expect(descriptionToSend({ description: '  ', descriptionEdited: true }, 'Teja', '')).toEqual(
      { ok: true, value: undefined },
    );
    expect(
      descriptionToSend({ description: 'Teja', descriptionEdited: true }, 'Teja', ''),
    ).toEqual({ ok: true, value: undefined });
  });

  it('editada viaja recortada y con los largos al final', () => {
    expect(
      descriptionToSend({ description: ' Techo norte ', descriptionEdited: true }, 'Teja', ''),
    ).toEqual({ ok: true, value: 'Techo norte' });
    expect(
      descriptionToSend(
        { description: 'Techo norte', descriptionEdited: true },
        'Teja',
        '2 × 4.20 m',
      ),
    ).toEqual({ ok: true, value: 'Techo norte (2 × 4.20 m)' });
  });

  it('más larga que el tope (con los largos incluidos) se rechaza con el tope a la vista', () => {
    const long = 'x'.repeat(MAX_LINE_DESCRIPTION - 5);
    const result = descriptionToSend(
      { description: long, descriptionEdited: true },
      'Teja',
      '2 × 4.20 m',
    );
    expect(result.ok).toBe(false);
    expect(MAX_LINE_DESCRIPTION).toBe(240);
  });
});
