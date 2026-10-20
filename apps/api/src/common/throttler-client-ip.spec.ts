import { Test } from '@nestjs/testing';
import { type ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Controller, HttpCode, Post, Req, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import { Reflector } from '@nestjs/core';
import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIG_HEADER,
  CLIENT_IP_TS_HEADER,
  loginIpKey,
  signClientIp,
} from '../auth/client-ip';
import { ENV, loadEnv } from '../config/env';
import { AppThrottlerGuard, isLoginRoute, throttleTracker } from './throttler.guard';

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

/**
 * cc61 (SEC-01 de audit-02): Express enruta sin distinguir mayúsculas y con la barra final opcional;
 * el reconocimiento del login tiene que hacer lo mismo, o una variante de la ruta cae en la cubeta
 * de la IP (120 por minuto) en vez de la del correo (10 por minuto).
 */
const LOGIN_VARIANTS = [
  '/api/auth/login',
  '/api/auth/login/',
  '/api/Auth/login',
  '/api/AUTH/LOGIN',
  '/api/auth/Login/',
  '/auth/login',
  '/Auth/Login/',
];

describe('isLoginRoute (cc61, SEC-01)', () => {
  it.each(LOGIN_VARIANTS)('%s es el login y cuenta por correo', (path) => {
    expect(isLoginRoute({ path })).toBe(true);
    const r = { path, headers: {}, body: { email: 'Ana@AYR.pe' }, ip: VERCEL } as never;
    expect(throttleTracker(r, SECRET, Date.now())).toBe('email|ana@ayr.pe');
  });

  it.each(['/api/auth/login-x', '/api/auth/logins', '/api/auth/login//', '/api/auth/refresh'])(
    '%s no es el login',
    (path) => {
      expect(isLoginRoute({ path })).toBe(false);
    },
  );
});

@Controller('auth')
class LoginProbeController {
  @Post('login')
  @HttpCode(200)
  login(@Req() r: Request): { path: string } {
    return { path: r.path };
  }
}

describe('isLoginRoute frente al enrutado real de Express (cc61, SEC-01)', () => {
  it('toda variante que llega al handler del login la reconoce el guard', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LoginProbeController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      for (const path of ['/auth/login', '/Auth/login', '/AUTH/LOGIN', '/auth/Login/']) {
        const res = await request(app.getHttpServer()).post(path).send({});
        expect(res.status).toBe(200);
        expect(isLoginRoute({ path: (res.body as { path: string }).path })).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});
