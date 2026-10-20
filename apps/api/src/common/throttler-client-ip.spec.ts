import { Test } from '@nestjs/testing';
import { type ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIG_HEADER,
  CLIENT_IP_TS_HEADER,
  loginIpKey,
  signClientIp,
} from '../auth/client-ip';
import { ENV, loadEnv } from '../config/env';
import { AppThrottlerGuard, throttleTracker } from './throttler.guard';

/**
 * cc60 (D-695): la cubeta general y la de renovación de sesión cuentan por la IP del cliente cuando
 * la web la firma (D-692), con el código derivado de D-694; sin firma, por `req.ip`, como antes.
 */
const SECRET = 'cc60-secreto-de-prueba-0123456789abcdef01234';
const VERCEL = '76.76.21.21';

const signed = (ip: string, now: number) => {
  const ts = String(now);
  return {
    [CLIENT_IP_HEADER]: ip,
    [CLIENT_IP_TS_HEADER]: ts,
    [CLIENT_IP_SIG_HEADER]: signClientIp(SECRET, ip, ts),
  };
};
const req = (path: string, headers: Record<string, string> = {}) =>
  ({ path, headers, body: {}, ip: VERCEL }) as never;

describe('throttleTracker (cc60)', () => {
  const now = Date.now();

  it('con firma válida cuenta por el código de la IP del cliente, nunca la IP en claro', () => {
    const a = throttleTracker(req('/api/auth/refresh', signed('190.42.1.7', now)), SECRET, now);
    expect(a).toBe(`ip|${loginIpKey(SECRET, '190.42.1.7')}`);
    expect(a).not.toContain('190.42');
  });

  it('dos IP verificadas no comparten cupo; el mismo /64 de IPv6, sí', () => {
    const a = throttleTracker(req('/api/customers', signed('190.42.1.7', now)), SECRET, now);
    const b = throttleTracker(req('/api/customers', signed('190.42.1.8', now)), SECRET, now);
    expect(a).not.toBe(b);
    const v6a = throttleTracker(req('/api/x', signed('2800:200:e840:1f2a::1', now)), SECRET, now);
    const v6b = throttleTracker(req('/api/x', signed('2800:200:e840:1f2a::9', now)), SECRET, now);
    expect(v6a).toBe(v6b);
  });

  it('sin firma, con firma mala o sin secreto, como hoy: la IP de la conexión', () => {
    expect(throttleTracker(req('/api/customers'), SECRET, now)).toBe(VERCEL);
    const forged = { ...signed('190.42.1.7', now), [CLIENT_IP_SIG_HEADER]: 'x'.repeat(43) };
    expect(throttleTracker(req('/api/customers', forged), SECRET, now)).toBe(VERCEL);
    expect(throttleTracker(req('/api/customers', signed('190.42.1.7', now)), undefined, now)).toBe(
      VERCEL,
    );
  });

  it('el login sigue contando por correo (D-675)', () => {
    const r = {
      path: '/api/auth/login',
      headers: signed('190.42.1.7', now),
      body: { email: 'Ana@AYR.pe ' },
      ip: VERCEL,
    } as never;
    expect(throttleTracker(r, SECRET, now)).toBe('email|ana@ayr.pe');
  });
});

describe('AppThrottlerGuard (cc60): la renovación de un usuario no frena a otro', () => {
  it('31 renovaciones desde una IP se frenan; otra IP verificada sigue entrando', async () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
      DIRECT_URL: 'postgresql://u:p@localhost:5432/test',
      JWT_SECRET: 'x'.repeat(40),
      JOBS_ENABLED: 'false',
      AYR_CLIENT_IP_SECRET: SECRET,
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 30 }] }),
      ],
      providers: [{ provide: ENV, useValue: env }, AppThrottlerGuard, Reflector],
    }).compile();
    const guard = moduleRef.get(AppThrottlerGuard);
    await (guard as unknown as ThrottlerGuard).onModuleInit();
    const handler = () => undefined;
    class Controller {}
    const ctx = (ip: string): ExecutionContext => {
      const headers = signed(ip, Date.now());
      const request = { path: '/api/auth/refresh', headers, body: {}, ip: VERCEL };
      const response = { header: jest.fn(), setHeader: jest.fn() };
      return {
        getHandler: () => handler,
        getClass: () => Controller,
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      } as unknown as ExecutionContext;
    };
    for (let i = 0; i < 30; i += 1)
      await expect(guard.canActivate(ctx('190.42.1.7'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('190.42.1.7'))).rejects.toThrow();
    await expect(guard.canActivate(ctx('190.42.1.8'))).resolves.toBe(true);
    await moduleRef.close();
  });
});
