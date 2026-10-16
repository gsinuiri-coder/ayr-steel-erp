import { runApiCli } from './run-api-cli.mjs';

// cc55: chequeos previos de las correcciones de datos del corte C. Solo lectura, sin execute.
runApiCli({
  compiled: 'dist-cli/prisma/inspect-cc55-cli.js',
  what: 'mide la re-fecha de D-278 y audita la bobina de la compra 118-315630 (solo lectura)',
});
