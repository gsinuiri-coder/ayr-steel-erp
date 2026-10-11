import { runApiCli } from './run-api-cli.mjs';

// cc46: diagnóstico de solo lectura de los partidos internos y el valor de su kerf y borde (D-608).
// Sin modo execute.
runApiCli({
  compiled: 'dist-cli/prisma/inspect-cc46-cli.js',
  what: 'diagnostica los partidos internos con kerf o borde (solo lectura)',
});
