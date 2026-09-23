// Barrido de lo ya importado (RF-S4b). Dry-run por defecto.
//
// Uso:
//   pnpm sweep:imported --file local-data/ventas-agosto-2026.xlsx [--branch local|local-e2e|dev|demo|production]
//   pnpm sweep:imported --file … --execute --branch production --confirm-production
//
// La lógica vive en `apps/api/prisma/sweep-imported-documents-cli.ts`, que usa los servicios de dominio.
import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/sweep-imported-documents-cli.js',
  what: 'reescribe líneas de cotizaciones y pedidos reales abiertos',
  pathFlags: new Set(['--file']),
});
