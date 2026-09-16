/**
 * Redacción defensiva de `before`/`after` antes de escribir en `audit_log` (D-218/RF-S2).
 *
 * Ningún llamador de hoy mete un secreto en un evento de auditoría (verificado en el PASO 0
 * de esta sesión: `auditView()` de cada servicio ya arma un objeto propio con una lista
 * blanca de campos, nunca el modelo de Prisma entero). Esto es la segunda red, no la
 * primera: si un llamador futuro pasa el objeto completo por descuido, una clave que
 * *parezca* un secreto no llega a quedar en texto plano en una tabla que después va a tener
 * un visor abierto a todo ADMINISTRADOR (M3) — mismo criterio y mismo patrón de regex que
 * `scripts/lib.mjs#run` ya usa para los mensajes de error de un proceso hijo (regla dura 5).
 */
const SECRET_KEY_PATTERN = /secret|password|token/i;
const REDACTED = '[redactado]';

/** Tope por evento (before + after combinados), documentado: ~8000 caracteres de JSON. Un
 *  evento normal —un puñado de campos de una fila— no se acerca; esto es para el caso raro
 *  de un objeto grande pasado por error, no para el uso normal. */
export const MAX_AUDIT_JSON_CHARS = 8_000;

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Redacta y, si el resultado sigue siendo más grande que el tope, lo reemplaza entero por un
 * marcador — nunca corta el JSON a la mitad (dejaría una fila con un objeto inválido).
 */
export function sanitizeAuditJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const redacted = redactValue(value);
  if (JSON.stringify(redacted).length > MAX_AUDIT_JSON_CHARS) {
    return { truncated: true, reason: `Supera ${MAX_AUDIT_JSON_CHARS} caracteres` };
  }
  return redacted;
}
