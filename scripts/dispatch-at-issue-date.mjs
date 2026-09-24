// Despacho a la fecha del comprobante (D-278): lo facturado y no despachado. Dry-run por defecto.
//
// Uso:
//   pnpm dispatch:at-issue-date [--branch local|local-e2e|dev|demo|production]
//   pnpm dispatch:at-issue-date --execute --expect <plan.json> --branch production --confirm-production
//
// La lógica vive en `apps/api/src/invoicing/invoice-dispatch.service.ts`.
import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/dispatch-at-issue-date-cli.js',
  what: 'registra despachos (salidas de kardex) a la fecha de los comprobantes',
  pathFlags: new Set(['--expect']),
});
