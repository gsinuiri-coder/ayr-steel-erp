import { z } from 'zod';
import type {
  CoilStatus,
  DispatchStatus,
  FiscalDocumentStatus,
  ProductionOrderStatus,
  PurchaseStatus,
  QuotationStatus,
  SalesOrderStatus,
} from '../enums';

/**
 * D-289: filtro de estado múltiple de las listas paginadas. Acepta `?status=A,B` (lo que
 * escribe la web) o `?status=A&status=B` (lo que serializa Express), y devuelve la lista
 * validada; un valor vacío equivale a no filtrar. Un solo estado sigue siendo válido, así que
 * los llamadores que ya pasaban `status=X` no cambian.
 */
export function statusListSchema<V extends string>(values: readonly [V, ...V[]]) {
  return z.preprocess(
    (raw) => {
      if (typeof raw === 'string') {
        const list = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return list.length > 0 ? list : undefined;
      }
      return raw;
    },
    z
      .array(z.enum(values as [V, ...V[]]))
      .min(1)
      .max(values.length)
      .optional(),
  );
}

/**
 * D-289: los estados terminales *negativos* de cada entidad —anulada, revertida, dada de
 * baja—. Una lista sin `status` explícito y sin `search` **no los trae**: son historia que
 * estorba en la bandeja de trabajo, y la web los muestra con el chip «Anulados». Buscar
 * (por código, cliente o documento) sí los encuentra: quien pega `PED-000123` quiere ese
 * pedido esté como esté.
 *
 * `REJECTED` de un comprobante **no** está: un rechazo de SUNAT se corrige y reenvía, es
 * trabajo pendiente y no historia. Un pedido `FULFILLED` tampoco (es terminal *positivo*; la
 * web lo separa con su propio chip «Atendidos», D-289).
 */
export const NEGATIVE_TERMINAL_STATUSES = {
  quotation: ['CANCELLED'],
  salesOrder: ['CANCELLED'],
  coil: ['CANCELLED'],
  fiscalDocument: ['VOIDED', 'ANNULLED'],
  purchase: ['CANCELLED'],
  dispatch: ['REVERSED'],
  productionOrder: ['CANCELLED'],
} as const satisfies {
  quotation: readonly QuotationStatus[];
  salesOrder: readonly SalesOrderStatus[];
  coil: readonly CoilStatus[];
  fiscalDocument: readonly FiscalDocumentStatus[];
  purchase: readonly PurchaseStatus[];
  dispatch: readonly DispatchStatus[];
  productionOrder: readonly ProductionOrderStatus[];
};

/**
 * Traduce el filtro de estado de una consulta a la condición de columna de Prisma:
 * - con `statuses` explícitos → `{ in: statuses }`;
 * - sin ellos y sin `skipDefault` → `{ notIn: negativos }` (el default de D-289);
 * - sin ellos y con `skipDefault` → sin condición.
 *
 * `skipDefault` es verdadero cuando hay `search` (quien busca por código quiere ese documento
 * esté como esté) o cuando la consulta está acotada a un padre (`salesOrderId`): «los despachos
 * de este pedido» son todos, incluidos los revertidos. El default es para la bandeja.
 */
export function statusCondition<T extends string>(
  statuses: readonly T[] | undefined,
  negativeTerminals: readonly T[],
  skipDefault: boolean,
): { in: T[] } | { notIn: T[] } | undefined {
  if (statuses && statuses.length > 0) return { in: [...statuses] };
  if (skipDefault) return undefined;
  return { notIn: [...negativeTerminals] };
}
