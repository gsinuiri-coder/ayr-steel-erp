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
