/**
 * cc31 (ESPEC §6): los motivos de lista de los diálogos de operación. Lo que viaja al API sigue
 * siendo un texto libre (el de siempre): «Borde dañado — golpe de montacargas», o solo el motivo.
 */
export const OTHER_REASON = 'Otro';

/** Anular un documento o una operación. */
export const ANNUL_REASONS = [
  'Error de digitación',
  'Documento duplicado',
  'El cliente desistió',
  'Precio o cantidad equivocados',
  OTHER_REASON,
] as const;

/** Registrar merma de una bobina. */
export const SCRAP_REASONS = [
  'Borde dañado',
  'Óxido o humedad',
  'Golpe en el traslado',
  'Defecto de fábrica',
  'Recorte de producción',
  OTHER_REASON,
] as const;

/** El texto del motivo: «Otro» es el detalle; el resto, el motivo y el detalle si lo hay. */
export function composeReason(choice: string, detail: string): string {
  const d = detail.trim();
  if (!choice) return '';
  if (choice === OTHER_REASON) return d;
  return d ? `${choice} — ${d}` : choice;
}
