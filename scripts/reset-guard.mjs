// RF-S4b: la cerradura del reset de una rama de Neon (`db-reset-dev.mjs`), aparte para poder
// probarla sin llamar a Neon. Se evalúa sobre lo que Neon **devolvió** para cada rama, no sobre
// el nombre que se tipeó: el reset se hace después por id, así que lo comprobado es exactamente
// lo que se resetea.

/**
 * Repaso de RF-S4b (P2-5): el nombre con el que `--preserve-under-name` guarda el estado viejo.
 * Nunca el de una rama que ya existe por convención (`production`, `demo`, `dev`, `ci`, los
 * respaldos): una segunda rama con ese nombre volvería ambiguos a los guiones que resuelven
 * por nombre. Tiene que decir de qué rama sale: `dev-antes-de-…` o `demo-antes-de-…`.
 *
 * @param {string} branch la rama que se resetea
 * @param {string} name el nombre pedido
 * @returns {string | null} el motivo para rechazarlo, o `null` si sirve
 */
export function preserveNameRefusal(branch, name) {
  const prefix = `${branch}-antes-de-`;
  if (!name.startsWith(prefix) || name.length === prefix.length) {
    return `--preserve-under-name tiene que empezar con «${prefix}» y decir el motivo (recibido: «${name}»).`;
  }
  return null;
}

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
