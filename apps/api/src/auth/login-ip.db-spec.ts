import { HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { assertTestDatabase } from '../../prisma/test-db-guard';
import { AuditService } from '../audit/audit.service';
import { loadEnv } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService, LOGIN_IP_MAX_FAILURES, LOGIN_IP_WINDOW_MS } from './auth.service';
import {
  CLIENT_IP_HEADER,
  CLIENT_IP_SIG_HEADER,
  CLIENT_IP_TS_HEADER,
  signClientIp,
  verifyClientIp,
} from './client-ip';

/**
 * cc59 (D-693, D-694) — **el límite por IP del login, contra la base.** Los intentos fallidos de
 * una IP verificada se cuentan en `audit_log`, así que valen con varias instancias de Cloud Run.
 */
const prisma = new PrismaClient();
const SECRET = 'cc59-secreto-de-prueba-0123456789abcdef0123';
const env = loadEnv({ ...process.env, AYR_CLIENT_IP_SECRET: SECRET });
const auth = new AuthService(
  prisma as unknown as PrismaService,
  new JwtService({ secret: env.JWT_SECRET }),
  new AuditService(prisma as unknown as PrismaService),
  env,
);

/** La IP como la firma la web, en el instante `now`. */
function from(ip: string, now = Date.now()) {
  const ts = String(now);
  return verifyClientIp(
    {
      [CLIENT_IP_HEADER]: ip,
      [CLIENT_IP_TS_HEADER]: ts,
      [CLIENT_IP_SIG_HEADER]: signClientIp(SECRET, ip, ts),
    },
    SECRET,
    now,
  );
}

/** Una IP de documentación al azar, para que cada caso cuente desde cero. */
const randomIp = () => `198.51.100.${String(Math.floor(Math.random() * 250) + 1)}`;
const email = () => (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();

async function fail(ip: string): Promise<unknown> {
  try {
    await auth.login(
      { email: `nadie-${randomUUID()}@ayr.test`, password: 'mala' },
      { clientIp: from(ip) },
    );
  } catch (err) {
    return err;
  }
  throw new Error('Se esperaba un rechazo');
}

beforeAll(() => {
  assertTestDatabase();
});

afterAll(async () => {
  jest.useRealTimers();
  await prisma.$disconnect();
});

describe('cc59: límite de intentos fallidos por IP', () => {
  it(`el intento ${String(LOGIN_IP_MAX_FAILURES + 1)} da 429 y vuelve a abrir al pasar la ventana`, async () => {
    const ip = randomIp();
    for (let i = 0; i < LOGIN_IP_MAX_FAILURES; i += 1) {
      expect(await fail(ip)).toBeInstanceOf(UnauthorizedException);
    }
    const blocked = await fail(ip);
    expect(blocked).toBeInstanceOf(HttpException);
    expect((blocked as HttpException).getStatus()).toBe(429);
    // Otra IP no se mezcla.
    expect(await fail(randomIp().replace('198.51.100', '203.0.113'))).toBeInstanceOf(
      UnauthorizedException,
    );
    // Al pasar la ventana, la misma IP vuelve a poder probar.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout'] });
    jest.setSystemTime(Date.now() + LOGIN_IP_WINDOW_MS + 60_000);
    expect(await fail(ip)).toBeInstanceOf(UnauthorizedException);
    jest.useRealTimers();
  });

  it('un login correcto no reinicia la cuenta de la IP, y no deja la IP en claro', async () => {
    const ip = randomIp().replace('198.51.100', '192.0.2');
    for (let i = 0; i < LOGIN_IP_MAX_FAILURES - 1; i += 1) await fail(ip);
    const password = process.env.ADMIN_PASSWORD ?? '';
    await auth.login({ email: email(), password }, { clientIp: from(ip) });
    await fail(ip);
    const blocked = await fail(ip);
    expect((blocked as HttpException).getStatus()).toBe(429);
    const rows = await prisma.auditLog.findMany({ where: { entity: 'login_ip' }, take: 50 });
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((r) => r.entityId !== ip && !JSON.stringify(r.after ?? {}).includes(ip)),
    ).toBe(true);
  });
});
