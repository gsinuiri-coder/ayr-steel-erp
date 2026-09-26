import { describe, expect, it } from 'vitest';
import { coilTone } from './status-tone';

/** D-328: una vigente se colorea por su film; el resto conserva el tono de su estado. */
describe('coilTone', () => {
  it('sellada es neutra y abierta está en curso', () => {
    expect(coilTone({ status: 'OPEN', film: 'SEALED' })).toBe('outline');
    expect(coilTone({ status: 'OPEN', film: 'OPENED' })).toBe('progress');
  });

  it('terminada, anulada y en corte conservan su tono, sin importar el film', () => {
    expect(coilTone({ status: 'CLOSED', film: 'SEALED' })).toBe('done');
    expect(coilTone({ status: 'CANCELLED', film: 'OPENED' })).toBe('outline');
    expect(coilTone({ status: 'IN_THIRD_PARTY', film: 'OPENED' })).toBe('progress');
  });
});
