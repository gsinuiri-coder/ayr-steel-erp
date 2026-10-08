import { runApiCli } from './run-api-cli.mjs';

// cc34: diagnóstico histórico de solo lectura del despunte por bobina (B1). Sin modo execute.
runApiCli({
  compiled: 'dist-cli/prisma/inspect-cc34-cli.js',
  what: 'diagnostica el despunte por bobina de cc34 (solo lectura)',
});
