import type { ExecutionContext } from '@nestjs/common';
import { LOGIN_IP_LIMIT, loginIpThrottler } from './throttler.guard';

/** cc58 (D-688, C-08 de audit-01): la segunda cubeta del login, por IP. */
const ctx = (path: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ path }) }) }) as unknown as ExecutionContext;

describe('loginIpThrottler', () => {
  it('cuenta por IP, 30 por minuto, y solo en el login', () => {
    const t = loginIpThrottler(false);
    expect([t.name, t.ttl, t.limit]).toEqual(['loginIp', 60_000, LOGIN_IP_LIMIT]);
    expect(LOGIN_IP_LIMIT).toBe(30);
    expect(t.skipIf?.(ctx('/api/auth/login'))).toBe(false);
    expect(t.skipIf?.(ctx('/api/auth/refresh'))).toBe(true);
    expect(t.skipIf?.(ctx('/api/customers'))).toBe(true);
  });

  it('la clave es la IP que resuelve Express, aunque el correo cambie', async () => {
    const t = loginIpThrottler(false);
    const tracker = t.getTracker as (req: Record<string, unknown>) => string | Promise<string>;
    expect(await tracker({ ip: '10.0.0.7', body: { email: 'a@b.pe' } })).toBe('ip|10.0.0.7');
    expect(await tracker({ ip: '10.0.0.7', body: { email: 'otro@b.pe' } })).toBe('ip|10.0.0.7');
    expect(await tracker({})).toBe('ip|sin-ip');
  });

  it('con el limitador apagado (E2E), también se salta en el login', () => {
    expect(loginIpThrottler(true).skipIf?.(ctx('/api/auth/login'))).toBe(true);
  });
});
