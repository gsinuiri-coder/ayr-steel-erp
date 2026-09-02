import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthUser, ChangePasswordInput, LoginInput } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import type { AccessTokenPayload, RequestUser } from './auth.types';

export interface ClientMeta {
  userAgent?: string;
  ip?: string;
}

export interface IssuedTokens {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/** Segundos en que se sigue aceptando el refresh token anterior tras rotarlo. */
const REFRESH_GRACE_MS = 30_000;

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');
const newRefreshToken = (): string => randomBytes(48).toString('base64url');

/** Hash de relleno para que un correo inexistente tarde lo mismo que uno real (anti-enumeración). */
const DUMMY_HASH_PROMISE = argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** RF-01: login con correo y contraseña. Crea una sesión con refresh token. */
  async login(input: LoginInput, meta: ClientMeta = {}): Promise<IssuedTokens> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const ok = await argon2.verify(
      user?.passwordHash ?? (await DUMMY_HASH_PROMISE),
      input.password,
    );
    if (!user || !ok) {
      await this.audit.log({
        actorId: user?.id ?? null,
        action: 'auth.login.failed',
        entity: 'users',
        entityId: user?.id ?? null,
        after: { email: input.email },
      });
      throw new UnauthorizedException('Credenciales inválidas');
    }
    if (!user.active) {
      throw new ForbiddenException('Usuario desactivado. Contacta al administrador.');
    }

    const refreshToken = newRefreshToken();
    const refreshExpiresAt = this.refreshExpiry();
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
        userAgent: meta.userAgent?.slice(0, 512),
        ip: meta.ip?.slice(0, 64),
      },
    });
    await this.audit.log({
      actorId: user.id,
      action: 'auth.login',
      entity: 'sessions',
      entityId: session.id,
    });
    return {
      user: this.toAuthUser(user),
      accessToken: await this.signAccess(user, session.id),
      refreshToken,
      refreshExpiresAt,
    };
  }

  /**
   * Rota el refresh token y emite un nuevo access token. Acepta el hash anterior
   * durante REFRESH_GRACE_MS para no cerrar la sesión si dos pestañas refrescan a la vez.
   */
  async refresh(rawRefreshToken: string, meta: ClientMeta = {}): Promise<IssuedTokens> {
    const hash = hashToken(rawRefreshToken);
    const now = new Date();
    const session = await this.prisma.session.findFirst({
      where: {
        OR: [
          { refreshTokenHash: hash },
          {
            previousTokenHash: hash,
            rotatedAt: { gte: new Date(now.getTime() - REFRESH_GRACE_MS) },
          },
        ],
      },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= now) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
    if (!session.user.active) {
      await this.revokeAllSessions(session.userId);
      throw new ForbiddenException('Usuario desactivado. Contacta al administrador.');
    }
    const refreshToken = newRefreshToken();
    const refreshExpiresAt = this.refreshExpiry();
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: hashToken(refreshToken),
        previousTokenHash: session.refreshTokenHash,
        rotatedAt: now,
        expiresAt: refreshExpiresAt,
        lastUsedAt: now,
        userAgent: meta.userAgent?.slice(0, 512) ?? session.userAgent,
        ip: meta.ip?.slice(0, 64) ?? session.ip,
      },
    });
    return {
      user: this.toAuthUser(session.user),
      accessToken: await this.signAccess(session.user, session.id),
      refreshToken,
      refreshExpiresAt,
    };
  }

  /** Cierra la sesión indicada por id (access token válido) o por refresh token (access expirado). */
  async logout(params: { sessionId?: string; rawRefreshToken?: string }): Promise<void> {
    const ids: string[] = [];
    if (params.sessionId) ids.push(params.sessionId);
    if (params.rawRefreshToken) {
      const hash = hashToken(params.rawRefreshToken);
      const byToken = await this.prisma.session.findFirst({
        where: { OR: [{ refreshTokenHash: hash }, { previousTokenHash: hash }] },
        select: { id: true },
      });
      if (byToken) ids.push(byToken.id);
    }
    if (ids.length === 0) return;
    const sessions = await this.prisma.session.findMany({
      where: { id: { in: ids }, revokedAt: null },
      select: { id: true, userId: true },
    });
    if (sessions.length === 0) return;
    await this.prisma.session.updateMany({
      where: { id: { in: sessions.map((s) => s.id) } },
      data: { revokedAt: new Date() },
    });
    for (const s of sessions) {
      await this.audit.log({
        actorId: s.userId,
        action: 'auth.logout',
        entity: 'sessions',
        entityId: s.id,
      });
    }
  }

  /** Cambio de contraseña del propio usuario. Revoca las demás sesiones. */
  async changePassword(user: RequestUser, input: ChangePasswordInput): Promise<void> {
    const dbUser = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const ok = await argon2.verify(dbUser.passwordHash, input.currentPassword);
    if (!ok) throw new UnauthorizedException('La contraseña actual es incorrecta');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await this.hashPassword(input.newPassword), mustChangePassword: false },
    });
    await this.revokeAllSessions(user.id, user.sessionId);
    await this.audit.log({
      actorId: user.id,
      action: 'auth.password.changed',
      entity: 'users',
      entityId: user.id,
    });
  }

  /**
   * Valida el access token y la sesión asociada. Si la sesión fue revocada
   * (cambio de rol, desactivación, logout) o el rol ya no coincide, rechaza (RF-03).
   */
  async validateAccessToken(token: string): Promise<RequestUser> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Sesión expirada');
    }
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.userId !== payload.sub) {
      throw new UnauthorizedException('Sesión invalidada');
    }
    const { user } = session;
    if (!user.active || user.role !== payload.role) {
      throw new UnauthorizedException('Sesión invalidada');
    }
    return { ...this.toAuthUser(user), sessionId: session.id };
  }

  /** RF-03: invalida todas las sesiones abiertas de un usuario. */
  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, { type: argon2.argon2id });
  }

  toAuthUser(user: User): AuthUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
  }

  private signAccess(user: User, sessionId: string): Promise<string> {
    const payload: AccessTokenPayload = { sub: user.id, sid: sessionId, role: user.role };
    return this.jwt.signAsync(payload, { expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS });
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  }
}
