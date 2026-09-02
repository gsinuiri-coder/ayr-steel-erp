import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Role, type User } from '@prisma/client';
import argon2 from 'argon2';
import { AuditService } from '../audit/audit.service';
import { ENV, loadEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

const env = loadEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/test',
  DIRECT_URL: 'postgresql://u:p@localhost:5432/test',
  JWT_SECRET: 'x'.repeat(40),
  ACCESS_TOKEN_TTL_SECONDS: '900',
  JOBS_ENABLED: 'false',
});

function makePrismaMock() {
  return {
    user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
    session: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let jwt: JwtService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let user: User;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'admin@ayr.test',
      name: 'Admin',
      passwordHash: await argon2.hash('Secreta123', { type: argon2.argon2id }),
      role: Role.ADMINISTRADOR,
      active: true,
      mustChangePassword: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  beforeEach(async () => {
    prisma = makePrismaMock();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: ENV, useValue: env },
        {
          provide: JwtService,
          useValue: new JwtService({ secret: env.JWT_SECRET, signOptions: { expiresIn: 900 } }),
        },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
    jwt = moduleRef.get(JwtService);
  });

  describe('login', () => {
    it('emite tokens y crea sesión con credenciales válidas', async () => {
      prisma.user.findUnique.mockResolvedValue(user);
      prisma.session.create.mockResolvedValue({ id: 'sess-1' });

      const result = await service.login({ email: user.email, password: 'Secreta123' });

      expect(result.user).toEqual({
        id: user.id,
        email: user.email,
        name: user.name,
        role: Role.ADMINISTRADOR,
        mustChangePassword: false,
      });
      expect(result.refreshToken).toHaveLength(64);
      const payload = jwt.verify<{ sub: string; sid: string; role: string }>(result.accessToken);
      expect(payload).toMatchObject({ sub: user.id, sid: 'sess-1', role: Role.ADMINISTRADOR });
      expect(prisma.session.create).toHaveBeenCalledTimes(1);
      expect(prisma.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            refreshTokenHash: expect.not.stringContaining(result.refreshToken),
          }),
        }),
      );
    });

    it('rechaza contraseña incorrecta con 401 y audita el intento', async () => {
      prisma.user.findUnique.mockResolvedValue(user);
      await expect(service.login({ email: user.email, password: 'mala' })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.login.failed' }),
      );
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it('rechaza correo inexistente con 401 (mismo mensaje)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login({ email: 'nadie@ayr.test', password: 'x' })).rejects.toThrow(
        'Credenciales inválidas',
      );
    });

    it('usuario desactivado no entra aunque la contraseña sea correcta', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...user, active: false });
      await expect(
        service.login({ email: user.email, password: 'Secreta123' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.session.create).not.toHaveBeenCalled();
    });
  });

  describe('validateAccessToken (RF-03)', () => {
    async function tokenFor(sid: string, role: Role = Role.ADMINISTRADOR): Promise<string> {
      return jwt.signAsync({ sub: user.id, sid, role });
    }

    it('acepta sesión viva con rol vigente', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's1',
        userId: user.id,
        revokedAt: null,
        user,
      });
      const result = await service.validateAccessToken(await tokenFor('s1'));
      expect(result).toMatchObject({ id: user.id, role: Role.ADMINISTRADOR, sessionId: 's1' });
    });

    it('rechaza sesión revocada', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's1',
        userId: user.id,
        revokedAt: new Date(),
        user,
      });
      await expect(service.validateAccessToken(await tokenFor('s1'))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rechaza token cuyo rol ya no coincide con el del usuario', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's1',
        userId: user.id,
        revokedAt: null,
        user: { ...user, role: Role.VENDEDOR },
      });
      await expect(service.validateAccessToken(await tokenFor('s1'))).rejects.toThrow(
        'Sesión invalidada',
      );
    });

    it('rechaza usuario desactivado', async () => {
      prisma.session.findUnique.mockResolvedValue({
        id: 's1',
        userId: user.id,
        revokedAt: null,
        user: { ...user, active: false },
      });
      await expect(service.validateAccessToken(await tokenFor('s1'))).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rechaza token firmado con otro secreto', async () => {
      const other = new JwtService({ secret: 'y'.repeat(40) });
      const token = await other.signAsync({ sub: user.id, sid: 's1', role: Role.ADMINISTRADOR });
      await expect(service.validateAccessToken(token)).rejects.toThrow('Sesión expirada');
    });
  });

  describe('refresh', () => {
    it('rota el refresh token y emite nuevo access token', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's1',
        userId: user.id,
        revokedAt: null,
        refreshTokenHash: 'hash-viejo',
        expiresAt: new Date(Date.now() + 60_000),
        user,
      });
      prisma.session.update.mockResolvedValue({});
      const result = await service.refresh('token-viejo');
      expect(result.refreshToken).toHaveLength(64);
      expect(prisma.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's1' },
          data: expect.objectContaining({ previousTokenHash: 'hash-viejo' }),
        }),
      );
    });

    it('rechaza refresh expirado', async () => {
      prisma.session.findFirst.mockResolvedValue({
        id: 's1',
        userId: user.id,
        revokedAt: null,
        refreshTokenHash: 'hash-viejo',
        expiresAt: new Date(Date.now() - 1),
        user,
      });
      await expect(service.refresh('x')).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('logout', () => {
    it('revoca por refresh token aunque el access token haya expirado', async () => {
      prisma.session.findFirst.mockResolvedValue({ id: 's9' });
      prisma.session.findMany.mockResolvedValue([{ id: 's9', userId: user.id }]);
      await service.logout({ rawRefreshToken: 'refresh-viejo' });
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['s9'] } },
        data: { revokedAt: expect.any(Date) },
      });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.logout' }));
    });

    it('sin cookies no hace nada', async () => {
      await service.logout({});
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });
  });

  it('revokeAllSessions marca revokedAt en todas las sesiones vivas', async () => {
    await service.revokeAllSessions(user.id);
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
