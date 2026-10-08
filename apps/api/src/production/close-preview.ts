import { CoilStatus, InventoryItemType, type Prisma } from '@prisma/client';
import {
  Decimal,
  productionOrderCode,
  toDecimal,
  toFixedString,
  type PlantClosePreviewDto,
} from '@ayr/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { RawMaterialShortfall } from '../sales/raw-material';
import { lockOrder } from './production-shared';

/**
 * cc27 (UX26-03, D-453): **la vista previa de un cierre de planta es el cierre mismo, deshecho.**
 *
 * «Ejecutar y cerrar», «Reportar y cerrar» y «Cerrar sin reportar más» mueven kardex, sueltan
 * despunte o merma y pueden terminar bobinas, todo en un clic. Antes de ese clic planta ve un
 * resumen, y el resumen no puede salir de una cuenta aparte: el reparto entre bobinas
 * (`allocateRoofingScrap`, cc34), el tope por lo montado (D-246), la tolerancia (D-388/D-389) y la
 * terminación automática (D-360) viven en el código del cierre, y una copia se separaría.
 *
 * Así que la vista previa corre **la misma acción** (`run`) dentro de una transacción, lee el
 * estado que dejó y la deshace lanzando `PreviewRollback`. No queda nada escrito: ni kardex, ni
 * auditoría, ni la clave de idempotencia (la acción real la reclama aparte). Lo único que no
 * vuelve atrás son los contadores de Postgres de las columnas `autoincrement` (el `id` del kardex
 * y de la auditoría, el `seq` interno de los reportes): quedan huecos que no se muestran en
 * ninguna pantalla ni documento.
 */

/**
 * cc28: el tope de la transacción de la vista previa es **el de su acción real** (120 s el
 * borrador, 60 s los cierres). SM-8 de cc27 proponía 20 s para soltar antes los candados, pero con
 * eso un borrador grande que el cierre real sí ejecuta fallaba en la vista previa con un 500
 * (segundo modelo de cc28, SM-1). Los candados que retiene son los mismos y por el mismo tiempo
 * que retendría el cierre real.
 */
export const COMMIT_PREVIEW_TIMEOUT_MS = 120_000;
export const CLOSE_PREVIEW_TIMEOUT_MS = 60_000;

class PreviewRollback extends Error {
  constructor(readonly preview: PlantClosePreviewDto) {
    super('Vista previa: la transacción se deshace a propósito');
  }
}

/** El texto con el que el reporte anota una fila confirmada con la casilla (D-389). */
const OUT_OF_TOLERANCE_PREFIX = 'Fuera de tolerancia';

interface CoilState {
  code: string;
  status: CoilStatus;
  balanceKg: Decimal;
}

async function coilStates(
  tx: Prisma.TransactionClient,
  coilIds: readonly string[],
): Promise<Map<string, CoilState>> {
  if (coilIds.length === 0) return new Map();
  const [coils, balances] = await Promise.all([
    tx.coil.findMany({
      where: { id: { in: [...coilIds] } },
      select: { id: true, code: true, status: true },
    }),
    tx.inventoryBalance.findMany({
      where: { itemType: InventoryItemType.COIL, itemId: { in: [...coilIds] } },
      select: { itemId: true, qty: true },
    }),
  ]);
  const balanceOf = new Map(balances.map((b) => [b.itemId, toDecimal(b.qty.toString())]));
  return new Map(
    coils.map((c) => [
      c.id,
      { code: c.code, status: c.status, balanceKg: balanceOf.get(c.id) ?? new Decimal(0) },
    ]),
  );
}

/**
 * Corre `run` en una transacción, resume lo que hizo con la orden y la deshace.
 *
 * Los errores de `run` salen tal cual (motivo de despunte, casilla de tolerancia, fecha fuera de
 * orden de D-124): son los mismos que daría la acción, y el web los atiende igual.
 */
export async function previewPlantClose(
  prisma: PrismaService,
  orderId: string,
  run: (tx: Prisma.TransactionClient, warnings: RawMaterialShortfall[]) => Promise<void>,
  timeoutMs: number,
): Promise<PlantClosePreviewDto> {
  try {
    await prisma.$transaction(
      async (tx) => {
        // cc28 (A-6 de cc27): la orden se bloquea **antes** de leer el «antes», como lo hace la
        // acción. Sin esto, un movimiento que entraba entre la lectura y el bloqueo de la acción
        // aparecía en el resumen como consumo de este cierre.
        // cc30: la acción puede escribir pedido y reserva: pedido → OP desde el inicio.
        await lockOrder(tx, orderId, { parent: true });
        const order = await tx.productionOrder.findUniqueOrThrow({
          where: { id: orderId },
          select: { seq: true },
        });
        // Las bobinas montadas **antes**: el cierre las suelta, así que después ya no se leen
        // por `releasedAt: null`.
        const mounted = await tx.productionOrderConsumption.findMany({
          where: { productionOrderId: orderId, releasedAt: null },
          select: { coilId: true },
          orderBy: { createdAt: 'asc' },
        });
        const coilIds = [...new Set(mounted.map((m) => m.coilId))];
        const reportsBefore = await tx.productionReport.findMany({
          where: { productionOrderId: orderId },
          select: { id: true },
        });
        const before = await coilStates(tx, coilIds);

        const warnings: RawMaterialShortfall[] = [];
        await run(tx, warnings);

        const after = await coilStates(tx, coilIds);
        const closed = await tx.productionOrder.findUniqueOrThrow({
          where: { id: orderId },
          select: { scrapKg: true },
        });
        const newReports = await tx.productionReport.findMany({
          where: {
            productionOrderId: orderId,
            id: { notIn: reportsBefore.map((r) => r.id) },
          },
          select: { rawMaterialWarning: true },
          orderBy: { seq: 'asc' },
        });

        const coils = coilIds.flatMap((id) => {
          const b = before.get(id);
          const a = after.get(id);
          if (b === undefined || a === undefined) return [];
          return [
            {
              coilId: id,
              coilCode: b.code,
              consumedKg: toFixedString(b.balanceKg.minus(a.balanceKg), 'KG'),
              balanceBeforeKg: toFixedString(b.balanceKg, 'KG'),
              balanceAfterKg: toFixedString(a.balanceKg, 'KG'),
              terminated: b.status === CoilStatus.OPEN && a.status === CoilStatus.CLOSED,
            },
          ];
        });

        throw new PreviewRollback({
          orderId,
          orderCode: productionOrderCode(order.seq),
          coils,
          scrapKg: toFixedString(closed.scrapKg === null ? '0' : closed.scrapKg.toString(), 'KG'),
          // La nota del reporte junta la desviación y los avisos en un texto (D-154): la fila que
          // pasó la tolerancia se muestra con su nota entera, que es lo que va a quedar escrito.
          outOfTolerance: newReports.flatMap((r, i) =>
            r.rawMaterialWarning?.includes(OUT_OF_TOLERANCE_PREFIX)
              ? [`Fila ${String(i + 1)}: ${r.rawMaterialWarning}`]
              : [],
          ),
          warnings: [...new Set(warnings.map((w) => w.message))],
        });
      },
      { timeout: timeoutMs, maxWait: 15_000 },
    );
  } catch (err) {
    if (err instanceof PreviewRollback) return err.preview;
    throw err;
  }
  // `run` terminó sin que la transacción lanzara: no puede pasar, `PreviewRollback` se lanza
  // siempre. Si pasara, la transacción se habría confirmado; se avisa en vez de mentir.
  throw new Error('La vista previa del cierre no se deshizo');
}
