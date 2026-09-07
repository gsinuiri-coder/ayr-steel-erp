/**
 * La regla de D-112, en un módulo propio para que **todo** el repo la pueda aplicar.
 *
 * Cortar un timestamp con `.slice(0, 10)` lo lee en UTC. Lima va cinco horas detrás, así que
 * todo lo ocurrido después de las 19:00 locales queda fechado al día siguiente. D-112 la
 * puso en el web, donde M-4 había encontrado el defecto en nueve pantallas.
 *
 * Vive acá desde D-131: la regla **no cubría `e2e/`**, y ahí había dieciséis lugares
 * armando fechas con `new Date().toISOString().slice(0, 10)`. Cuando D-124 pasó a validar
 * las fechas de negocio contra Lima, esos dieciséis empezaron a fallar de noche y en
 * cualquier huso por delante — y lo descubrió CI, no la revisión.
 *
 * Son selectores de AST puros: no necesitan información de tipos, así que se pueden aplicar
 * a una carpeta sin `tsconfig` propio (que es exactamente el caso de `e2e/`).
 */
export const businessDateRules = [
  {
    selector:
      "CallExpression[callee.property.name='slice'][arguments.0.value=0][arguments.1.value=10][callee.object.property.name=/At$/]",
    message:
      'No cortes un timestamp con slice(0, 10): lee en UTC, no en Lima (D-112). Usa formatTimestampDate() de @/lib/format.',
  },
  {
    selector:
      "CallExpression[callee.property.name='slice'][arguments.0.value=0][arguments.1.value=10][callee.object.callee.property.name='toISOString']",
    message:
      'No cortes toISOString() con slice(0, 10) para "hoy": lee en UTC, no en Lima (D-112). Usa businessToday() de @ayr/shared.',
  },
];
