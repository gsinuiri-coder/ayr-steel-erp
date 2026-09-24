import { assertCliRunAllowed } from '../src/common/cli-branch-gate';

/**
 * RF-S4b: la cerradura de las CLI de dominio, con el entorno del proceso. La regla y sus tests
 * viven en `src/common/cli-branch-gate.ts`.
 */
export function assertExecuteAllowed(execute: boolean): void {
  assertCliRunAllowed(process.env, execute);
}
