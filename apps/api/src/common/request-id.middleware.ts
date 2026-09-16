import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestId } from './request-context';

/**
 * Un `requestId` por petición (D-218/RF-S2), para correlacionar en `audit_log` todos los
 * eventos que una misma petición HTTP haya escrito (una venta de mostrador escribe varios:
 * el pedido, el despacho, el comprobante, el cobro). Se expone también en la respuesta
 * (`X-Request-Id`) por si hace falta pegarlo a un reporte de soporte.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  runWithRequestId(requestId, next);
}
