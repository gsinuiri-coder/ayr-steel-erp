// Retiro de un color sin uso y sus specs sobrantes (D-274). Dry-run por defecto.
//
// Uso:
//   pnpm retire:unused-color --code NATURAL [--branch local|local-e2e|dev|demo|production]
//   pnpm retire:unused-color --code NATURAL --execute --branch production --confirm-production
//
// La lógica vive en `apps/api/src/colors/color-retirement.ts`, detrás de `ColorsService`.
import { runApiCli } from './run-api-cli.mjs';

runApiCli({
  compiled: 'dist-cli/prisma/retire-unused-color-cli.js',
  what: 'desactiva un color del maestro y borra sus specs de materia prima sobrantes',
});
