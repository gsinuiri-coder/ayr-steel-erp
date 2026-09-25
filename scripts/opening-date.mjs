// Fecha efectiva del inventario inicial (D-285) y lo que destraba. Dry-run por defecto.
//
// Uso:
//   pnpm inventory:opening-date [--branch local|local-e2e|dev|demo|production]
//   pnpm inventory:opening-date --execute --expect <plan.json> --branch production --confirm-production
//
// La lógica vive en `apps/api/src/invoicing/opening-date-move.service.ts`.
import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/opening-date-cli.js',
  what: 'cambia la fecha de la carga inicial del kardex y registra salidas y despachos',
  pathFlags: new Set(['--expect']),
});
