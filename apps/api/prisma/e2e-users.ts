/**
 * Patrón único de los usuarios que crean los E2E. Vive aparte porque lo comparten
 * la creación del admin efímero y la limpieza: si los dos criterios se separan,
 * la limpieza podría dejar cuentas vivas (o borrar lo que no debe).
 */
export const E2E_EMAIL_PREFIX = 'e2e-';
export const E2E_EMAIL_SUFFIX = '@ayr.test';

/** Solo los correos que cumplen prefijo y sufijo son elegibles para la limpieza. */
export function isE2EUserEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized.startsWith(E2E_EMAIL_PREFIX) && normalized.endsWith(E2E_EMAIL_SUFFIX);
}
