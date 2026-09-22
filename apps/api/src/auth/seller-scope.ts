import { NotFoundException } from '@nestjs/common';
import { Role, type Prisma } from '@prisma/client';
import type { RequestUser } from './auth.types';

/** Política única de alcance comercial RF-S3c. Lo ajeno se presenta como inexistente. */
export function sellerWhere(actor: RequestUser): Prisma.SalesOrderWhereInput {
  return actor.role === Role.VENDEDOR ? { sellerId: actor.id } : {};
}

export function quotationSellerWhere(actor: RequestUser): Prisma.QuotationWhereInput {
  return actor.role === Role.VENDEDOR ? { sellerId: actor.id } : {};
}

export function assertSellerAccess(
  actor: RequestUser,
  sellerId: string | null,
  entity = 'Recurso',
): void {
  if (actor.role !== Role.VENDEDOR) return;
  if (sellerId === actor.id) return;
  throw new NotFoundException(`${entity} no encontrado`);
}

/**
 * Dueño comercial de un pedido (D-240). El pedido que nace de una cotización hereda el dueño
 * **de la cotización**, no de quien lo confirmó: confirmar es un acto operativo y a menudo lo
 * hace un ADMINISTRADOR sobre la cotización de un vendedor. Solo el pedido directo —sin
 * cotización— pertenece a quien lo creó.
 *
 * Vive acá, y no dentro del servicio, porque el backfill de `seller_id`
 * (`apps/api/prisma/backfill-seller-scope.ts`) tiene que aplicar **esta misma** regla sobre las
 * filas históricas. Dos copias de la regla fue exactamente el defecto que se corrigió.
 */
export function resolveOrderSeller(order: {
  quotation: { sellerId: string | null; createdById: string } | null;
  createdById: string;
}): string {
  if (order.quotation) return order.quotation.sellerId ?? order.quotation.createdById;
  return order.createdById;
}
