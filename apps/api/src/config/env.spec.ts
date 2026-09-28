import { loadEnv } from './env';

/**
 * C06 — `BIND_HOST`: el API escucha en todas las interfaces salvo que se lo ate. `pnpm dev:demo`
 * lo ata a `127.0.0.1` porque demo es copia de datos reales con los hashes de producción.
 */
const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  DIRECT_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(40),
};

describe('loadEnv — BIND_HOST (C06)', () => {
  it('por defecto 0.0.0.0 (Cloud Run y el día a día no cambian)', () => {
    expect(loadEnv({ ...BASE }).BIND_HOST).toBe('0.0.0.0');
  });

  it('demo lo ata a localhost', () => {
    expect(loadEnv({ ...BASE, BIND_HOST: '127.0.0.1' }).BIND_HOST).toBe('127.0.0.1');
  });

  it('una interfaz que no es una IP no arranca', () => {
    expect(() => loadEnv({ ...BASE, BIND_HOST: 'todas' })).toThrow();
  });
});
