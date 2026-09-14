/**
 * Adelanta el correlativo de todas las series fiscales de la base de PRUEBAS a un punto de
 * partida propio de esta corrida (D-202). Corre desde `e2e/global-setup.ts`, **solo después
 * de un reset** y del seed, y solo contra una base de la lista blanca de `test-db-guard.ts`.
 *
 * **Por qué.** El reset vacía `fiscal_series` y el seed la vuelve a crear con correlativo `0`,
 * así que toda corrida emitía `F001-00000001`, `F001-00000002`… La cuenta demo de Nubefact, en
 * cambio, **recuerda** los números que ya recibió: la segunda corrida chocaba contra los de la
 * primera y el gate `pnpm e2e:pse` exigía vaciar la cuenta hasta 0 exacto antes de cada
 * ventana, aunque quedara cupo. Con un punto de partida por corrida, dos corridas no reusan
 * números y el cupo de 50 comprobantes vuelve a ser la única restricción real.
 *
 * **La base sale del reloj, en segundos**: `10 000 000 + (epoch en segundos mod 80 000 000)`.
 * - En segundos y no en minutos: una corrida local y una de CI que arrancan en el mismo minuto
 *   partirían del mismo número. En segundos, dos corridas separadas por `n` segundos solo se
 *   pisan si una emite más de `n` comprobantes de una misma serie, y el propio arranque de la
 *   suite (build, reset, seed) tarda más que el cupo entero de la cuenta demo.
 * - El módulo mantiene el número en ocho dígitos, que es lo que SUNAT admite y lo que valida
 *   `createFiscalSeriesSchema` (`max(99_999_999)`): el tope es 90 000 000 y queda margen de
 *   sobra para lo que emite una corrida. Da la vuelta cada ~2,5 años.
 * - El piso de 10 000 000 deja fuera de rango los números bajos que cualquier otra cosa que
 *   hable con la cuenta demo pueda haber usado empezando desde 1.
 *
 * Nunca contra una base con historia: el correlativo es un hecho fiscal. Por eso solo toca
 * series que están **por debajo** del punto de partida, y el llamador solo lo invoca tras un
 * reset.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabase } from './test-db-guard';

const FLOOR = 10_000_000;
const RANGE = 80_000_000;

function runCorrelativeBase(nowMs: number): number {
  return FLOOR + (Math.floor(nowMs / 1000) % RANGE);
}

async function main(): Promise<void> {
  const label = assertTestDatabase();
  const base = runCorrelativeBase(Date.now());
  const prisma = new PrismaClient();
  try {
    const { count } = await prisma.fiscalSeries.updateMany({
      where: { correlative: { lt: base } },
      data: { correlative: base },
    });
    console.warn(
      `Correlativos de ${label}: ${String(count)} series parten de ${String(base)} en esta corrida.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
