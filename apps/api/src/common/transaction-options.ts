/**
 * cc53 (hotfix): el tope de las transacciones que pueden registrar o revertir una devolución de NC
 * (D-646) o disparar un recosteo por fecha (D-649). Contra Neon, los 5 s por defecto de Prisma no
 * alcanzan: registrar una NC de devolución daba 500 («Transaction already closed», 5000 ms). Mismo
 * margen que las reactivaciones (D-378, `REACTIVATION_TX_TIMEOUT_MS`), con una espera por la
 * conexión acorde. Lo fija `transaction-options.sentinel.spec.ts`.
 */
export const KARDEX_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * cc58 (D-683, B-03 de audit-01): el tope de las operaciones que **recostean en bloque**: cierres y
 * reaperturas de OP (D-665), anular o editar una compra recibida, cambiar la fecha de un comprobante
 * que re-fecha sus despachos y el flete que llega tarde. Decisión del dueño: 60 s; todo lo demás del
 * día, 30 s (`KARDEX_TX_OPTIONS`). Los importadores y las herramientas de una vez quedan aparte, con
 * nombre, en `transaction-options.sentinel.spec.ts`.
 */
export const RECOST_TX_OPTIONS = { timeout: 60_000, maxWait: 15_000 } as const;
