/**
 * cc53 (hotfix): el tope de las transacciones que pueden registrar o revertir una devolución de NC
 * (D-646) o disparar un recosteo por fecha (D-649). Contra Neon, los 5 s por defecto de Prisma no
 * alcanzan: registrar una NC de devolución daba 500 («Transaction already closed», 5000 ms). Mismo
 * margen que las reactivaciones (D-378, `REACTIVATION_TX_TIMEOUT_MS`), con una espera por la
 * conexión acorde. Lo fija `transaction-options.sentinel.spec.ts`.
 */
export const KARDEX_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;
