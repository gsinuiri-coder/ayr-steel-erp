import { DispatchStatus, Prisma, SalesReturnStatus } from '@prisma/client';
import { salesReturnCode, type SalesOrderReturnsDto } from '@ayr/shared';

type Reader = Pick<Prisma.TransactionClient, 'salesReturn' | 'dispatchItem'>;

/**
 * cc58 (D-680, D-05 de audit-01): las devoluciones vivas del pedido y si devolvieron **todo** lo
 * despachado. Un pedido atendido (FULFILLED) que volvió entero sigue atendido —el estado es de la
 * entrega—, pero el detalle lo avisa. Se calcula al leer (regla 3.4: sin estado derivado guardado):
 * todo lo despachado con movimiento, línea de despacho por línea de despacho, contra lo devuelto.
 */
export async function orderReturns(
  db: Reader,
  salesOrderId: string,
): Promise<SalesOrderReturnsDto> {
  const [returns, dispatched] = await Promise.all([
    db.salesReturn.findMany({
      where: { salesOrderId, status: SalesReturnStatus.ACTIVE },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true, creditNote: { select: { id: true, number: true } } },
    }),
    db.dispatchItem.findMany({
      where: {
        movementId: { not: null },
        dispatch: { salesOrderId, status: DispatchStatus.ISSUED },
      },
      select: {
        qty: true,
        salesReturnItems: {
          where: { salesReturn: { status: SalesReturnStatus.ACTIVE } },
          select: { qty: true },
        },
      },
    }),
  ]);
  return {
    returns: returns.map((r) => ({
      id: r.id,
      code: salesReturnCode(r.seq),
      creditNoteId: r.creditNote.id,
      creditNoteNumber: r.creditNote.number,
    })),
    fullyReturned: isFullyReturned(dispatched),
  };
}

/** Todo lo despachado volvió: cada línea de despacho, con su cantidad devuelta ≥ la despachada. */
export function isFullyReturned(
  lines: readonly { qty: Prisma.Decimal; salesReturnItems: readonly { qty: Prisma.Decimal }[] }[],
): boolean {
  if (lines.length === 0) return false;
  return lines.every((l) =>
    l.salesReturnItems.reduce((sum, r) => sum.plus(r.qty), new Prisma.Decimal(0)).gte(l.qty),
  );
}
