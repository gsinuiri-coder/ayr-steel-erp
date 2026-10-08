import { runApiCli } from './run-api-cli.mjs';

// cc33: diagnóstico histórico de solo lectura (compras PEN con TC, comprobantes sobre pedidos
// ajenos, NC sobre facturas muertas, números con ceros, fechas). Sin modo execute.
runApiCli({
  compiled: 'dist-cli/prisma/inspect-cc33-cli.js',
  what: 'diagnostica los hallazgos de cc33 (solo lectura)',
});
