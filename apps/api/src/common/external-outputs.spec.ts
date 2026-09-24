import { assertExternalOutputsOff, externalOutputs } from './external-outputs';

/**
 * Revisión cruzada RF-S4b (P1-2): una CLI de dominio no arranca con la cola, el PSE ni R2
 * encendidos. Es lo que el wrapper deja (`EXTERNAL_OUTPUTS_OFF`); acá se prueba que la CLI se
 * niega si no lo encuentra, y que imprime las banderas.
 */
const OFF = {
  JOBS_ENABLED: 'false',
  PSE_ENABLED: 'false',
  R2_ACCOUNT_ID: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET: '',
};

describe('salidas externas de una CLI de dominio', () => {
  it('con el entorno del wrapper, las tres apagadas: imprime y sigue', () => {
    const lines: string[] = [];
    assertExternalOutputsOff(OFF, (l) => lines.push(l));
    expect(lines).toEqual([
      'Salidas externas: cola (JOBS_ENABLED) apagado · PSE (PSE_ENABLED) apagado · R2 apagado',
    ]);
  });

  it('JOBS_ENABLED sin definir es encendido (su default) y aborta', () => {
    const { JOBS_ENABLED: _j, ...rest } = OFF;
    expect(externalOutputs(rest).jobs).toBe(true);
    expect(() => {
      assertExternalOutputsOff(rest, () => undefined);
    }).toThrow(/salidas externas encendidas \(jobs\)/);
  });

  it('PSE encendido aborta', () => {
    expect(() => {
      assertExternalOutputsOff({ ...OFF, PSE_ENABLED: 'true' }, () => undefined);
    }).toThrow(/\(pse\)/);
  });

  it('cualquier credencial de R2 presente aborta, y se nombra', () => {
    const lines: string[] = [];
    expect(() => {
      assertExternalOutputsOff({ ...OFF, R2_BUCKET: 'ayr-prod' }, (l) => lines.push(l));
    }).toThrow(/\(r2\)/);
    expect(lines[0]).toMatch(/R2 ENCENDIDO/);
  });
});
