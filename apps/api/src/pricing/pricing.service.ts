import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type BusinessLineCode, type PricingSetting } from '@prisma/client';
import type { PricingSettingDto, UpdatePricingSettingInput } from '@ayr/shared';
import { toDecimal } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { toSharedLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';

type WithLineCode = PricingSetting & { businessLine: { code: BusinessLineCode } };

/** Márgenes por línea (D-032/P-09). Lectura para todos, edición solo ADMINISTRADOR. */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(): Promise<PricingSettingDto[]> {
    const settings = await this.prisma.pricingSetting.findMany({
      include: { businessLine: { select: { code: true } } },
      orderBy: { businessLine: { name: 'asc' } },
    });
    return settings.map(toDto);
  }

  async updateByBusinessLineId(
    actor: RequestUser,
    businessLineId: string,
    input: UpdatePricingSettingInput,
  ): Promise<PricingSettingDto> {
    const before = await this.prisma.pricingSetting.findUnique({
      where: { businessLineId },
      include: { businessLine: { select: { code: true } } },
    });
    if (!before) throw new NotFoundException('No hay configuración de márgenes para esa línea');

    const marginPct = input.marginPct ?? before.marginPct.toFixed(4);
    const minMarginPct = input.minMarginPct ?? before.minMarginPct.toFixed(4);
    if (toDecimal(marginPct).lt(toDecimal(minMarginPct))) {
      throw new BadRequestException('El margen no puede ser menor que el margen mínimo');
    }

    const data: Prisma.PricingSettingUpdateInput = {};
    if (input.marginPct !== undefined) data.marginPct = input.marginPct;
    if (input.minMarginPct !== undefined) data.minMarginPct = input.minMarginPct;

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.pricingSetting.update({
        where: { businessLineId },
        data,
        include: { businessLine: { select: { code: true } } },
      });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'pricing.update',
        entity: 'pricing_settings',
        entityId: updated.id,
        before: auditView(before),
        after: auditView(updated),
      });
      return updated;
    });
    return toDto(after);
  }
}

function toDto(p: WithLineCode): PricingSettingDto {
  return {
    id: p.id,
    businessLineId: p.businessLineId,
    businessLineCode: toSharedLineCode(p.businessLine.code),
    marginPct: p.marginPct.toFixed(4),
    minMarginPct: p.minMarginPct.toFixed(4),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function auditView(p: PricingSetting): Prisma.InputJsonObject {
  return { marginPct: p.marginPct.toFixed(4), minMarginPct: p.minMarginPct.toFixed(4) };
}
