// Smoke de E2E contra la rama Neon `ci` (D-202): un subconjunto chico y representativo de la
// suite, para validar **lo que solo Neon valida** —el pooler, los planes de consulta sobre una
// base real de Neon, las migraciones aplicadas ahí— sin pagar las ~300 consultas × latencia
// runner→Neon de la suite completa (D-201). La suite completa corre contra el Postgres de
// servicio del runner, en el job `e2e` de `.github/workflows/ci.yml`.
//
// Si Neon cae lejos del runner, esto se pone lento, pero son una docena de archivos y no 67:
// el timeout deja de ser una lotería.
//
// Criterio de la lista: un archivo por flujo que la empresa usa todos los días, prefiriendo los
// que ejercitan lo que depende de la base (locks de fila, consultas agregadas, transacciones
// largas) sobre los de pura pantalla. Si se agrega un flujo nuevo que dependa de Neon de una
// forma que el Postgres del runner no reproduce, entra acá.
//
// Uso: pnpm e2e:smoke   (en local corre contra `ayr_local_e2e`, igual que `pnpm e2e`)
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const SMOKE_SPECS = [
  // Acceso: login, refresh y sesiones en la tabla `sessions` (D-010).
  'e2e/tests/auth.spec.ts',
  // Flujo comercial nuevo (D-184..D-187): emitir, reserva temporal, confirmar en un paso.
  'e2e/tests/flujo-comercial-f8s2.spec.ts',
  // `stock-shortages`: la consulta agregada más cara del Panel (backlog de D-201).
  'e2e/tests/stock-shortage-f8s2b.spec.ts',
  // Staging de planta: borrador de reportes por OP y commit todo o nada (D-191).
  'e2e/tests/borrador-reportes-f8s3.spec.ts',
  // Cola de OPs y su ranking (D-189, D-194).
  'e2e/tests/planta-cola-f8s3-ui.spec.ts',
  // Montar varias bobinas a la vez (D-192).
  'e2e/tests/multi-montar-f8s3.spec.ts',
  // Kardex: compras y alta de bobinas (§3.2).
  'e2e/tests/fase2a.spec.ts',
  // Kardex: venta de bobina entera y su reversa (D-170).
  'e2e/tests/venta-bobina-entera-d170.spec.ts',
  // Facturación sin PSE atado: emisión en contingencia, el camino local (D-073, D-080).
  'e2e/tests/fase5b.spec.ts',
  // Despacho con peso por línea (D-183).
  'e2e/tests/despacho-peso-por-linea.spec.ts',
  // Idempotencia y concurrencia con locks de fila: lo que el pooler de Neon puede cambiar (D-182).
  'e2e/tests/idempotencia-f8s1-m2.spec.ts',
  // Punto de venta de mostrador (RF-60).
  'e2e/tests/fase7b.spec.ts',
];

const res = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'playwright', 'test', ...SMOKE_SPECS, ...process.argv.slice(2)],
  { cwd: ROOT, env: process.env, stdio: 'inherit', shell: process.platform === 'win32' },
);
process.exit(res.status ?? 1);
