import { Injectable } from '@nestjs/common';
import { businessToday, type ReceivablesAgingDto, type ReceivablesAgingQuery } from '@ayr/shared';
import { documentOwnerId, loadCollectibleDocuments } from '../invoicing/collectible-documents';
import { PrismaService } from '../prisma/prisma.service';
import { assembleReceivablesAging } from './receivables-aging';

/**
 * cc25 (D-421..D-423). Cuentas por cobrar por antigüedad. Solo lectura y solo administrador
 * (D-426, en el controlador).
 *
 * **Dos consultas fijas**, sin importar cuántos clientes o comprobantes haya: la lectura de
 * cobranzas (`loadCollectibleDocuments`, una) y los nombres de los vendedores (una). El saldo
 * no se recalcula: es el de cobranzas (D-421).
 */
@Injectable()
export class ReceivablesAgingService {
  constructor(private readonly prisma: PrismaService) {}

  async report(query: ReceivablesAgingQuery = {}): Promise<ReceivablesAgingDto> {
    const collectible = await loadCollectibleDocuments(this.prisma);
    const ownerIds = [...new Set(collectible.map((c) => documentOwnerId(c.document)))];
    const users =
      ownerIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: ownerIds } },
            select: { id: true, name: true },
          });
    return assembleReceivablesAging({
      collectible,
      sellerNames: new Map(users.map((u) => [u.id, u.name])),
      sellerId: query.sellerId ?? null,
      today: businessToday(),
    });
  }
}
