/**
 * «Recibir seleccionadas» (D-353): recibe varias compras en borrador **una por una**, cada una por
 * su propio `POST /purchases/:id/receive` —su transacción, sus reglas, sin ninguna regla nueva—, y
 * junta el resultado de cada una. Una que falla no detiene a las demás: cada recepción es un hecho
 * independiente, igual que si se hubieran recibido de a una desde su detalle.
 */

export interface ReceiveOutcome {
  id: string;
  label: string;
  ok: boolean;
  message: string;
}

export async function receiveSequentially(
  targets: readonly { id: string; label: string }[],
  receive: (id: string) => Promise<unknown>,
): Promise<ReceiveOutcome[]> {
  const outcomes: ReceiveOutcome[] = [];
  // En serie a propósito: dos recepciones a la vez compiten por los mismos saldos de kardex y
  // bloqueos, y el orden de los resultados tiene que ser el que el usuario eligió.
  for (const target of targets) {
    try {
      await receive(target.id);
      outcomes.push({ ...target, ok: true, message: 'Recibida' });
    } catch (err) {
      outcomes.push({
        ...target,
        ok: false,
        message: err instanceof Error ? err.message : 'No se pudo recibir',
      });
    }
  }
  return outcomes;
}

/** El resumen de la tanda: «3 recibidas, 1 con error». */
export function summarizeOutcomes(outcomes: readonly ReceiveOutcome[]): string {
  const ok = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - ok;
  const parts = [`${String(ok)} recibida${ok === 1 ? '' : 's'}`];
  if (failed > 0) parts.push(`${String(failed)} con error`);
  return parts.join(', ');
}
