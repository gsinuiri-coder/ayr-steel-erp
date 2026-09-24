import { assertCliRunAllowed } from './cli-branch-gate';

/** Repaso de RF-S4b (P1-B): la cerradura de destino de las CLI de dominio. */
describe('cerradura de destino de las CLI de dominio', () => {
  const env = (branch: string | undefined, confirmed: '0' | '1' = '0') => ({
    ...(branch === undefined ? {} : { AYR_CLI_BRANCH: branch }),
    AYR_CLI_CONFIRMED_PRODUCTION: confirmed,
  });

  it('contra production no corre sin --confirm-production, ni en dry-run ni en execute', () => {
    expect(() => {
      assertCliRunAllowed(env('production'), false);
    }).toThrow(/tampoco en dry-run/);
    expect(() => {
      assertCliRunAllowed(env('production'), true);
    }).toThrow(/sin --confirm-production/);
  });

  it('contra production con --confirm-production corre', () => {
    expect(() => {
      assertCliRunAllowed(env('production', '1'), false);
    }).not.toThrow();
    expect(() => {
      assertCliRunAllowed(env('production', '1'), true);
    }).not.toThrow();
  });

  it('contra demo no hace falta confirmar', () => {
    expect(() => {
      assertCliRunAllowed(env('demo'), true);
    }).not.toThrow();
  });

  it('sin rama declarada (JS compilado a mano) no escribe', () => {
    expect(() => {
      assertCliRunAllowed(env(undefined), true);
    }).toThrow(/solo corre desde su wrapper/);
    expect(() => {
      assertCliRunAllowed(env(undefined), false);
    }).not.toThrow();
  });
});
