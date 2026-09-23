// Normalización de SKU de bobina (D-252/D-253, RF-S4b). Dry-run por defecto.
//
// Uso:
//   pnpm normalize:coil-skus [--branch local|local-e2e|dev|demo|production]
//   pnpm normalize:coil-skus --execute [--ack-open-documents] --branch production --confirm-production
//
// La lógica vive en `apps/api/prisma/normalize-coil-skus-cli.ts`, que usa el servicio de dominio.
import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/normalize-coil-skus-cli.js',
  what: 'renombra y une productos reales del catálogo',
});
