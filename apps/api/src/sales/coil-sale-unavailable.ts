import { quotationCode, salesOrderCode } from '@ayr/shared';
import { isForeign, type HolderViewer } from './reserved-ledger';

/** Un documento que tiene tomada una bobina: su número y su vendedor. */
export interface CoilHolder {
  seq: number;
  sellerId: string | null;
}

/** Lo que tiene tomada una bobina con saldo que no se ofrece para venderla entera. */
export interface CoilHolders {
  /** Montada en una OP viva (D-060): asignar no mueve kardex. */
  mounted: boolean;
  /** Pedidos con reserva firme activa sobre la bobina. */
  firm: CoilHolder[];
  /** Cotizaciones con reserva temporal vigente sobre la bobina (D-185). */
  temporary: CoilHolder[];
}

/** El de menor número que quien lee puede ver (D-267/D-275), o `undefined`. */
function firstVisible(holders: CoilHolder[], viewer?: HolderViewer): CoilHolder | undefined {
  return [...holders].sort((a, b) => a.seq - b.seq).find((h) => !isForeign(h.sellerId, viewer));
}

/**
 * D-282: por qué una bobina con saldo no aparece entre las que se venden enteras. Mismo
 * vocabulario que el pool de venta de bobina (`coilPoolFor`): «montada en una OP», «atada a
 * COT-…» y, para un VENDEDOR frente a un documento ajeno, un motivo sin número.
 */
export function unavailableCoilReason(holders: CoilHolders, viewer?: HolderViewer): string {
  if (holders.mounted) return 'montada en una OP';
  if (holders.firm.length > 0) {
    const order = firstVisible(holders.firm, viewer);
    return order ? `reservada por ${salesOrderCode(order.seq)}` : 'reservada por un pedido';
  }
  if (holders.temporary.length > 0) {
    const quotation = firstVisible(holders.temporary, viewer);
    return quotation
      ? `atada a ${quotationCode(quotation.seq)} (reserva temporal)`
      : 'no disponible';
  }
  return 'sin saldo libre';
}
