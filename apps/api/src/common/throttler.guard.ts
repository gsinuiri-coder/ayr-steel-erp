import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Detrás del rewrite de Vercel todos los usuarios comparten la IP de salida del proxy.
 * Clave del límite: IP del cliente (primer salto de X-Forwarded-For) y, si el body
 * trae `email` (login), también el correo, para que un usuario no bloquee al resto.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Request): Promise<string> {
    const forwarded = req.headers['x-forwarded-for'];
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
    const ip = first !== undefined && first !== '' ? first : (req.ip ?? 'sin-ip');
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    return Promise.resolve(email ? `${ip}|${email}` : ip);
  }
}
