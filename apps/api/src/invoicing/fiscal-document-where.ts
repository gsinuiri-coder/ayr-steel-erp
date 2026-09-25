import { FiscalDocType, Role, type FiscalDocumentStatus, type Prisma } from '@prisma/client';
import { NEGATIVE_TERMINAL_STATUSES, statusCondition, type FiscalDocumentQuery } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';

/**
 * D-297: la condición de `GET /invoicing/documents`, aparte del servicio para poder probarla.
 *
 * **El alcance del vendedor y la búsqueda se combinan con `AND`, nunca compiten por la misma
 * clave.** Los dos son una lista de alternativas (`OR`): el alcance dice «lo que creé, o de mis
 * pedidos, o de mis despachos» y la búsqueda dice «número, cliente o documento». Asignar los dos
 * a `where.OR` dejaba solo el último, y un VENDEDOR que buscaba veía comprobantes de otros
 * vendedores. Cada uno va en su propio `OR` dentro de `AND`.
 */
export function fiscalDocumentListWhere(
  query: FiscalDocumentQuery,
  actor: RequestUser | undefined,
  liveStatuses: readonly FiscalDocumentStatus[],
): Prisma.FiscalDocumentWhereInput {
  const and: Prisma.FiscalDocumentWhereInput[] = [];
  if (actor && actor.role !== Role.ADMINISTRADOR) {
    and.push({
      OR: [
        { createdById: actor.id },
        { salesOrder: { sellerId: actor.id } },
        { dispatch: { salesOrder: { sellerId: actor.id } } },
      ],
    });
  }
  if (query.search) {
    and.push({
      OR: [
        { number: { contains: query.search, mode: 'insensitive' } },
        { customer: { name: { contains: query.search, mode: 'insensitive' } } },
        { customer: { docNumber: { contains: query.search, mode: 'insensitive' } } },
      ],
    });
  }

  const where: Prisma.FiscalDocumentWhereInput = {
    // D-289: sin estado, la bandeja omite los dados de baja (no si se busca o se acota a un
    // cliente/pedido: «los comprobantes de este cliente» son todos).
    status: statusCondition(
      query.status,
      NEGATIVE_TERMINAL_STATUSES.fiscalDocument,
      Boolean(query.search) || Boolean(query.customerId) || Boolean(query.salesOrderId),
    ),
    docType: query.docType,
    customerId: query.customerId,
    salesOrderId: query.salesOrderId,
    origin: query.origin,
    // RF-72: la versión archivada por una reimportación deja de ser el comprobante y sale
    // de la lista. Sigue existiendo, y se llega a ella desde la vigente que la reemplazó.
    ...(query.includeArchived ? {} : { archivedAt: null }),
    ...(and.length > 0 ? { AND: and } : {}),
  };
  if (query.pendingOnly) {
    // El saldo es derivado (D-075) y no se puede sumar en SQL sin duplicar la regla que
    // vive en `@ayr/shared`. Lo que **sí** se puede acotar en SQL es qué documentos son
    // capaces de tener saldo: sin esto, el universo a filtrar en memoria se llenaba de
    // borradores y notas de crédito.
    where.status = { in: [...liveStatuses] };
    where.docType = { in: [FiscalDocType.FACTURA, FiscalDocType.BOLETA] };
  }
  return where;
}
