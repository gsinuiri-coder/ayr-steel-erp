import { runApiCli } from './run-api-cli.mjs';

// cc44: diagnóstico de solo lectura de las recepciones de corte y su kerf (D-597). Sin modo execute.
runApiCli({
  compiled: 'dist-cli/prisma/inspect-cc44-cli.js',
  what: 'diagnostica las recepciones de corte de cc44 (solo lectura)',
});
