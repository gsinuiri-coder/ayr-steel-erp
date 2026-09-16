import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * `requestId` por petición (D-218/RF-S2), disponible en cualquier punto del árbol de llamadas
 * sin tocar la firma de los métodos existentes.
 *
 * Se genera **siempre en el servidor** (`RequestIdMiddleware`), nunca se confía en un
 * `x-request-id` que mande el cliente: esta API no está pensada para recibir tráfico de
 * terceros —Next.js es el único llamador, mismo origen (D-015)— y aceptar el header del
 * cliente abriría una vía de inyección en `audit_log.request_id` sin ninguna ganancia real.
 */
const storage = new AsyncLocalStorage<{ requestId: string }>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/** `undefined` fuera de una petición HTTP (un job, un script) — `AuditService` lo trata como tal. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
