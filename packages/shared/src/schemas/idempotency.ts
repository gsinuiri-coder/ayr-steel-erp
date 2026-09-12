import { z } from 'zod';

/**
 * Clave de idempotencia (D-182, F8-S1/M2): identifica un **intento de submit** del
 * cliente, no el hecho de negocio. Dos envíos con la misma clave son el mismo click
 * contado dos veces (doble click, reintento de red) y el segundo no debe repetir el
 * efecto; dos envíos con claves distintas son dos hechos legítimos aunque el resto del
 * payload sea idéntico (dos reportes de producción iguales, dos cobros iguales) — por eso
 * no se deriva del contenido del request, la genera el cliente una vez por intento (un
 * UUID nuevo por click, no por formulario).
 *
 * Solo aplica a las **creaciones repetibles** (RF de M2): una transición de estado
 * (confirmar, emitir, despachar) ya se protege con el lock de fila de su propia tabla —
 * el segundo request encuentra el estado ya avanzado y no necesita una clave para
 * saberlo.
 */
export const idempotencyKeySchema = z.string().trim().min(1).max(100);

export const idempotencyFields = {
  idempotencyKey: idempotencyKeySchema.optional(),
} as const;
