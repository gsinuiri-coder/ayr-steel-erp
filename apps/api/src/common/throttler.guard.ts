import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

/**
 * Detrás del proxy del web todos los usuarios comparten la IP de salida, así que el
 * límite no puede ser solo por IP.
 *
 * **No se usa `X-Forwarded-For` a mano.** Cloud Run *añade* la IP real al final de esa
 * cadena en vez de reemplazarla, y el servicio también es alcanzable por su URL pública:
 * tomar el primer salto dejaba que un atacante rotara la cabecera en cada petición y
 * anulara el límite de `/auth/login` por completo. Se usa `req.ip`, que Express resuelve
 * con `trust proxy` según la cadena real, y para el login manda el correo: un atacante
 * no puede cambiarlo sin dejar de atacar esa cuenta.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Request): Promise<string> {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email) return Promise.resolve(`email|${email}`);
    return Promise.resolve(req.ip ?? 'sin-ip');
  }
}
