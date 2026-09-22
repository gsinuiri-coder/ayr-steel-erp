import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QuotationStatus, TemporaryReservationStatus } from '@prisma/client';
import { businessToday, addBusinessDays } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getSellerDashboard(actor: RequestUser) {
    const today = businessToday();
    const in3Days = addBusinessDays(today, 3);
    const sellerId = actor.id;

    // 1. Cotizaciones por vencer (DRAFT, validUntil <= today + 3)
    const expiringQuotations = await this.prisma.quotation.count({
      where: {
        sellerId,
        status: QuotationStatus.DRAFT,
        validUntil: { lte: new Date(`${in3Days}T00:00:00.000Z`) },
      },
    });

    // 2. Reservas temporales por expirar (ACTIVE, expiresAt <= today + 3)
    // El umbral de expiración por defecto ya está configurado en `temporaryReservationExpiry` pero
    // El umbral de expiración por defecto ya está configurado en `temporaryReservationExpiry` pero
    const expiringReservations = await this.prisma.quotationReservation.count({
      where: {
        quotation: { sellerId },
        status: TemporaryReservationStatus.ACTIVE,
        expiresAt: { lte: new Date(new Date().getTime() + 3 * 24 * 60 * 60 * 1000) },
      },
    });

    // 3. Pedidos en produccion
    // Tiene alguna OP de Roofing en progreso
    const productionRes = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT s.id) as count
      FROM "sales_orders" s
      JOIN "reservations" r ON r."sales_order_id" = s."id"
      JOIN "production_orders" p ON p."reservation_id" = r."id"
      WHERE s."seller_id" = ${sellerId}::uuid 
        AND s."status" != 'CANCELLED'
        AND p."kind" = 'ROOFING' 
        AND p."status" = 'IN_PROGRESS'
    `;
    const productionOrders = productionRes?.[0]?.count ?? 0n;

    // 4. Pedidos listos para despacho
    // Tiene OP vivas (al menos 1), y NINGUNA OP viva esta en DRAFT o IN_PROGRESS
    const readyRes = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT s.id) as count
      FROM "sales_orders" s
      WHERE s."seller_id" = ${sellerId}::uuid 
        AND s."status" != 'CANCELLED'
        AND EXISTS (
          SELECT 1 FROM "reservations" r 
          JOIN "production_orders" p ON p."reservation_id" = r."id"
          WHERE r."sales_order_id" = s."id" AND p."status" != 'CANCELLED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM "reservations" r 
          JOIN "production_orders" p ON p."reservation_id" = r."id"
          WHERE r."sales_order_id" = s."id" AND p."status" IN ('DRAFT', 'IN_PROGRESS')
        )
    `;
    const readyOrders = readyRes?.[0]?.count ?? 0n;

    return {
      expiringQuotations,
      expiringReservations,
      productionOrders: Number(productionOrders),
      readyOrders: Number(readyOrders),
    };
  }
}
