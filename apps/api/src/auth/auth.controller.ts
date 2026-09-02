import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  loginSchema,
  type AuthUser,
  type ChangePasswordInput,
  type LoginInput,
} from '@ayr/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ENV, type Env } from '../config/env';
import { AuthService } from './auth.service';
import { ACCESS_COOKIE, REFRESH_COOKIE, type RequestUser } from './auth.types';
import { clearAuthCookies, setAuthCookies } from './cookies';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';

type Cookies = Partial<Record<string, string>>;

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthUser }> {
    const tokens = await this.auth.login(body, { userAgent: req.get('user-agent'), ip: req.ip });
    setAuthCookies(res, this.env, tokens);
    return { user: tokens.user };
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ user: AuthUser }> {
    const raw = (req.cookies as Cookies)[REFRESH_COOKIE];
    if (!raw) {
      clearAuthCookies(res, this.env);
      throw new UnauthorizedException('Sin sesión');
    }
    try {
      const tokens = await this.auth.refresh(raw, { userAgent: req.get('user-agent'), ip: req.ip });
      setAuthCookies(res, this.env, tokens);
      return { user: tokens.user };
    } catch (err) {
      clearAuthCookies(res, this.env);
      throw err;
    }
  }

  /**
   * Pública a propósito: debe funcionar aunque el access token ya haya expirado.
   * Revoca la sesión por access token (si es válido) y/o por refresh token, y limpia cookies siempre.
   */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const cookies = req.cookies as Cookies;
    let sessionId: string | undefined;
    const access = cookies[ACCESS_COOKIE];
    if (access) {
      try {
        sessionId = (await this.auth.validateAccessToken(access)).sessionId;
      } catch {
        /* access expirado o inválido: se revoca por refresh */
      }
    }
    await this.auth.logout({ sessionId, rawRefreshToken: cookies[REFRESH_COOKIE] });
    clearAuthCookies(res, this.env);
  }

  @Get('me')
  me(@CurrentUser() user: RequestUser): { user: AuthUser } {
    const { sessionId: _sid, ...rest } = user;
    return { user: rest };
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: ChangePasswordInput,
  ): Promise<void> {
    await this.auth.changePassword(user, body);
  }
}
