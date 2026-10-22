import { createHash } from 'node:crypto';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import argon2 from 'argon2';
import { loadEnv } from '../config/env';
import { AuthService, LOGIN_IP_MAX_FAILURES, LOGIN_IP_WINDOW_MS } from './auth.service';
import { loginIpKey, type ClientIpCheck } from './client-ip';

/**
 * cc59 (D-693): el límite por IP del login cuenta los intentos **fallidos** de una IP verificada en
 * `audit_log` (D-694). El límite por correo de siempre (throttler, D-675) no cambia: vive en el
 * controlador y no pasa por acá.
 */
const SECRET = 's'.repeat(43);
const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
  DIRECT_URL: 'postgresql://u:p@localhost:5432/test',
  JWT_SECRET: 'x'.repeat(40),
  JOBS_ENABLED: 'false',
  AYR_CLIENT_IP_SECRET: SECRET,
});
const verified = (ip: string): ClientIpCheck => ({ ok: true, ip });

describe('AuthService.login — límite por IP (cc59)', () => {
  let passwordHash = '';
  beforeAll(async () => {
    passwordHash = await argon2.hash('Secreta123', {
      type: argon2.argon2id,
      memoryCost: 1024,
      timeCost: 2,
      parallelism: 1,
    });
  }, 30_000);

  function build(failures: number, secretEnv = env) {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'admin@ayr.test',
      name: 'Admin',
      passwordHash,
      role: Role.ADMINISTRADOR,
      active: true,
      mustChangePassword: false,
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
      session: { create: jest.fn().mockResolvedValue({ id: 'sess-1' }) },
      auditLog: { count: jest.fn().mockResolvedValue(failures) },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      prisma as never,
      new JwtService({ secret: 'x'.repeat(40) }),
      audit as never,
      secretEnv,
    );
    return { service, prisma, audit };
  }

  it('un fallido con IP verificada queda contado con la clave de su IP, no con la IP', async () => {
    const { service, audit } = build(3);
    await expect(
      service.login(
        { email: 'admin@ayr.test', password: 'mala' },
        { clientIp: verified('190.42.1.7') },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login.failed.ip',
        entity: 'login_ip',
        entityId: loginIpKey(SECRET, '190.42.1.7'),
      }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('190.42.1.7');
  });

  it(`el intento ${String(LOGIN_IP_MAX_FAILURES + 1)} responde 429, también con la contraseña buena`, async () => {
    const { service, prisma } = build(LOGIN_IP_MAX_FAILURES);
    const attempt = service.login(
      { email: 'admin@ayr.test', password: 'Secreta123' },
      { clientIp: verified('190.42.1.7') },
    );
    await expect(attempt).rejects.toBeInstanceOf(HttpException);
    await expect(attempt).rejects.toMatchObject({ status: 429 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('cuenta solo la ventana de 15 minutos de esa IP: al pasar, vuelve a abrir', async () => {
    const { service, prisma } = build(LOGIN_IP_MAX_FAILURES - 1);
    const before = Date.now();
    await service.login(
      { email: 'admin@ayr.test', password: 'Secreta123' },
      { clientIp: verified('190.42.1.9') },
    );
    const where = (prisma.auditLog.count.mock.calls[0] as [{ where: Record<string, unknown> }])[0]
      .where;
    expect(where).toMatchObject({ entity: 'login_ip', entityId: loginIpKey(SECRET, '190.42.1.9') });
    const since = (where.at as { gt: Date }).gt.getTime();
    expect(since).toBeGreaterThanOrEqual(before - LOGIN_IP_WINDOW_MS);
    expect(since).toBeLessThanOrEqual(Date.now() - LOGIN_IP_WINDOW_MS);
  });

  it('un login correcto no escribe nada por IP (no reinicia la cuenta)', async () => {
    const { service, audit, prisma } = build(5);
    await service.login(
      { email: 'admin@ayr.test', password: 'Secreta123' },
      { clientIp: verified('190.42.1.7') },
    );
    // cc65 (SEC-05/A2-07): la sesión guarda el código de D-694 de la IP, no la IP en claro.
    expect(prisma.session.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ip: loginIpKey(SECRET, '190.42.1.7') }),
    });
    expect(
      audit.log.mock.calls.some(([e]) => (e as { entity: string }).entity === 'login_ip'),
    ).toBe(false);
  });

  it('sin IP verificada (o sin secreto) no cuenta por IP: sigue el límite por correo', async () => {
    for (const [check, secretEnv] of [
      [{ ok: false, reason: 'bad-signature' } as ClientIpCheck, env],
      [undefined, env],
      [verified('190.42.1.7'), { ...env, AYR_CLIENT_IP_SECRET: undefined }],
    ] as const) {
      const { service, prisma, audit } = build(LOGIN_IP_MAX_FAILURES + 5, secretEnv);
      await expect(
        service.login({ email: 'admin@ayr.test', password: 'mala' }, { clientIp: check }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.auditLog.count).not.toHaveBeenCalled();
      expect(
        audit.log.mock.calls.some(([e]) => (e as { entity: string }).entity === 'login_ip'),
      ).toBe(false);
    }
  });
});

describe('cc65 (SEC-05/A2-07): qué se guarda de la IP', () => {
  function build(secretEnv = env) {
    const prisma = {
      session: {
        create: jest.fn().mockResolvedValue({ id: 'sess-1' }),
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(
      prisma as never,
      new JwtService({ secret: 'x'.repeat(40) }),
      audit as never,
      secretEnv,
    );
    return { service, prisma, audit };
  }

  it('la renovación guarda en sessions.ip el código de la IP verificada, no la IP', async () => {
    const { service, prisma } = build();
    const raw = 'token-vigente';
    const hash = createHash('sha256').update(raw).digest('hex');
    prisma.session.findFirst.mockResolvedValue({
      id: 's3',
      userId: 'u1',
      revokedAt: null,
      refreshTokenHash: hash,
      previousTokenHash: null,
      rotatedAt: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      userAgent: null,
      ip: null,
      user: { id: 'u1', active: true, role: Role.ADMINISTRADOR, email: 'a@b.c', name: 'A' },
    });
    await service.refresh(raw, { clientIp: verified('190.42.1.7') });
    const rotatedIp = (): unknown =>
      (prisma.session.updateMany.mock.calls as unknown as [{ data: { ip: unknown } }][])[0]?.[0]
        .data.ip;
    expect(rotatedIp()).toBe(loginIpKey(SECRET, '190.42.1.7'));
    // Sin firma válida no se guarda nada nuevo: se conserva el código anterior…
    const previous = loginIpKey(SECRET, '190.42.1.8');
    const base = prisma.session.findFirst.mock.results[0]?.value as Promise<object>;
    prisma.session.findFirst.mockResolvedValue({ ...(await base), ip: previous });
    prisma.session.updateMany.mockClear();
    await service.refresh(raw, { clientIp: { ok: false, reason: 'absent' } });
    expect(rotatedIp()).toBe(previous);
    // …y una IP en claro heredada se borra.
    prisma.session.findFirst.mockResolvedValue({ ...(await base), ip: '10.0.0.1' });
    prisma.session.updateMany.mockClear();
    await service.refresh(raw, { clientIp: { ok: false, reason: 'expired' } });
    expect(rotatedIp()).toBeNull();
  });

  it('el reuso de un refresh guarda el código de D-694 de la IP verificada, no la IP', async () => {
    const { service, prisma, audit } = build();
    prisma.session.findFirst.mockResolvedValue({
      id: 's2',
      userId: 'u1',
      revokedAt: null,
      refreshTokenHash: 'otro',
      previousTokenHash: 'x',
      rotatedAt: new Date(Date.now() - 5 * 60_000),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: { active: true },
    });
    await expect(
      service.refresh('token-anterior', { clientIp: verified('190.42.1.7') }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.refresh.reuse',
        after: { ip: loginIpKey(SECRET, '190.42.1.7') },
      }),
    );
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('190.42.1.7');
  });

  it('sin firma válida no se guarda nada', async () => {
    const { service, prisma, audit } = build();
    prisma.session.findFirst.mockResolvedValue({
      id: 's2',
      userId: 'u1',
      revokedAt: null,
      refreshTokenHash: 'otro',
      previousTokenHash: 'x',
      rotatedAt: new Date(Date.now() - 5 * 60_000),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      user: { active: true },
    });
    await expect(
      service.refresh('token-anterior', { clientIp: { ok: false, reason: 'bad-signature' } }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.refresh.reuse', after: { ip: null } }),
    );
  });
});
