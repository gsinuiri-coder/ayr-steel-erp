import { Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';
import { loginIpKey, verifyClientIp, type ClientIpCheck } from '../auth/client-ip';
import { ENV, type Env } from '../config/env';

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
 *
 * cc60 (D-695): con la IP del cliente **firmada por la web** (D-692) y válida, la clave de las
 * demás rutas —la cubeta general y la de renovación de sesión— es esa IP, con el bloque /64 en
 * IPv6 y el mismo código derivado de D-694 (nunca la IP en claro). Sin firma válida, como antes:
 * `req.ip`. Los conteos siguen en memoria por instancia (D-696).
 */
/** `POST /auth/login` (con o sin el prefijo global `/api`). */
export function isLoginRoute(req: Pick<Request, 'path'>): boolean {
  return /\/auth\/login\/?$/.test(req.path);
}

/** La clave de la cubeta: el correo en el login; si no, la IP verificada o `req.ip`. */
export function throttleTracker(req: Request, secret: string | undefined, now: number): string {
  // cc57 (C-08 de audit-01): el correo es la clave **solo en el login**. En cualquier otra ruta
  // con `email` en el cuerpo (alta de cliente o de usuario) compartían cubeta usuarios distintos
  // que grababan el mismo correo.
  const body = req.body as { email?: unknown } | undefined;
  const email =
    isLoginRoute(req) && typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email) return `email|${email}`;
  const check = verifyClientIp(req.headers, secret, now);
  if (check.ok && secret) return `ip|${loginIpKey(secret, check.ip)}`;
  return req.ip ?? 'sin-ip';
}

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger('Throttle');
  /** El último estado avisado en esta instancia: se avisa al cambiar, no en cada petición. */
  private lastState: string | null = null;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {
    super(options, storage, reflector);
  }

  protected override getTracker(req: Request): Promise<string> {
    const now = Date.now();
    const tracker = throttleTracker(req, this.env.AYR_CLIENT_IP_SECRET, now);
    if (!tracker.startsWith('email|')) {
      this.noteState(verifyClientIp(req.headers, this.env.AYR_CLIENT_IP_SECRET, now));
    }
    return Promise.resolve(tracker);
  }

  /** Deja en el log (sin la IP) si la instancia cuenta por IP verificada o por qué no. */
  private noteState(check: ClientIpCheck): void {
    const state = check.ok ? 'verificada' : check.reason;
    if (state === this.lastState) return;
    this.lastState = state;
    this.logger.log(
      check.ok
        ? 'Límites por IP verificada del cliente'
        : `Límites por la IP de la conexión (IP del cliente: ${state})`,
    );
  }
}
