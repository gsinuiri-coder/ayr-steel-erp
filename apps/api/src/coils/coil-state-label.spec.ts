import {
  COIL_FILM_EVENT_TYPE_LABELS,
  COIL_FILM_SOURCE_LABELS,
  COIL_FILM_SOURCES,
  COIL_STATUS_LABELS,
  coilStateLabel,
} from '@ayr/shared';

/**
 * D-328 — cómo se rotula una bobina con sus dos ejes: el estado (vigente / terminada / anulada /
 * en corte) y el film (sellada / abierta). Una vigente se nombra por su film; lo demás, por su
 * estado, porque el film de una terminada ya no le dice nada a nadie.
 */
describe('coilStateLabel', () => {
  it('una vigente se nombra por su film', () => {
    expect(coilStateLabel({ status: 'OPEN', film: 'SEALED' })).toBe('Sellada');
    expect(coilStateLabel({ status: 'OPEN', film: 'OPENED' })).toBe('Abierta');
  });

  it('una terminada, anulada o en corte se nombra por su estado, sin importar el film', () => {
    for (const film of ['SEALED', 'OPENED'] as const) {
      expect(coilStateLabel({ status: 'CLOSED', film })).toBe('Terminada');
      expect(coilStateLabel({ status: 'CANCELLED', film })).toBe('Anulada');
      expect(coilStateLabel({ status: 'IN_THIRD_PARTY', film })).toBe('En corte tercerizado');
    }
  });

  it('«cerrada» ya no aparece: el estado CLOSED se llama Terminada', () => {
    expect(COIL_STATUS_LABELS.CLOSED).toBe('Terminada');
    expect(COIL_STATUS_LABELS.OPEN).toBe('Vigente');
  });

  it('cada fuente y cada tipo de evento del historial tiene su rótulo', () => {
    for (const source of COIL_FILM_SOURCES) {
      expect(COIL_FILM_SOURCE_LABELS[source]).toBeTruthy();
    }
    expect(COIL_FILM_EVENT_TYPE_LABELS.OPENED).toBe('Abierta');
    expect(COIL_FILM_EVENT_TYPE_LABELS.RESEALED).toBe('Vuelta a sellar');
  });
});
