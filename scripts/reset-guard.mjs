// RF-S4b: la cerradura del reset de una rama de Neon (`db-reset-dev.mjs`), aparte para poder
// probarla sin llamar a Neon. Se evalúa sobre lo que Neon **devolvió** para cada rama, no sobre
// el nombre que se tipeó: el reset se hace después por id, así que lo comprobado es exactamente
// lo que se resetea.

/**
 * @param {{ id: string; name: string; parent_id?: string | null }} target la rama a resetear
 * @param {{ id: string; name: string }} parent la rama de la que se copia (production)
 * @returns {string | null} el motivo para abortar, o `null` si se puede resetear
 */
export function resetRefusal(target, parent) {
  if (!target?.id || !parent?.id) return 'Neon no devolvió el id de alguna de las dos ramas.';
  // Nunca production: ni por nombre ni por id (regla dura 4, D-251).
  if (target.id === parent.id || target.name === 'production') {
    return `La rama destino es production (${target.name}, ${target.id}): nunca se resetea.`;
  }
  if (target.parent_id !== parent.id) {
    return (
      `La rama '${target.name}' no cuelga de '${parent.name}' (su padre es ${target.parent_id ?? 'ninguno'}).\n` +
      'Revisa la topología en Neon antes de resetear: este guion solo sabe reponer desde el padre.'
    );
  }
  return null;
}
