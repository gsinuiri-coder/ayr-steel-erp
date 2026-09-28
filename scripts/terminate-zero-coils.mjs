// Terminación única de las bobinas vigentes con saldo 0 (D-360). Dry-run por defecto; la
// ejecución guarda un lote y deja la reversa `--undo <lote>`.
//
// Uso:
//   pnpm terminate:zero-coils [--branch local|local-e2e|dev|demo|production]
//   pnpm terminate:zero-coils --execute --branch production --confirm-production
//   pnpm terminate:zero-coils --undo <lote> [--execute] --branch production --confirm-production
//
// La lógica vive en `apps/api/src/coils/terminate-zero-coils.ts`.
import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/terminate-zero-coils-cli.js',
  what: 'termina las bobinas vigentes con saldo 0 (o reabre las de un lote con --undo)',
});
