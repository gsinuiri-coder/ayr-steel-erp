// Retirada de las recetas de drywall (D-344). Dry-run por defecto.
//
// Uso:
//   pnpm retire:boms [--branch local|local-e2e|dev|demo|production]
//   pnpm retire:boms --branch demo --execute
//   pnpm retire:boms --branch production --confirm-production     (dry-run: confirma 0 activas)
//
// La lógica vive en `apps/api/src/production/bom-retirement.ts`, con auditoría por receta.
import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/retire-boms-cli.js',
  what: 'desactiva las recetas de drywall que sigan activas',
});
