import { Injectable, NotFoundException } from '@nestjs/common';
import type { BusinessLine } from '@prisma/client';
import type { BusinessLineDto } from '@ayr/shared';
import { toSharedLineCode } from '../common/business-line-code';
import { PrismaService } from '../prisma/prisma.service';

/** Líneas de negocio (§2.2): datos fijos sembrados, solo lectura (RF-25 contexto). */
@Injectable()
export class BusinessLinesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<BusinessLineDto[]> {
    const lines = await this.prisma.businessLine.findMany({ orderBy: { name: 'asc' } });
    return lines.map(toDto);
  }

  async findOne(id: string): Promise<BusinessLineDto> {
    const line = await this.prisma.businessLine.findUnique({ where: { id } });
    if (!line) throw new NotFoundException('Línea de negocio no encontrada');
    return toDto(line);
  }
}

function toDto(l: BusinessLine): BusinessLineDto {
  return {
    id: l.id,
    code: toSharedLineCode(l.code),
    name: l.name,
    inventoryStrategy: l.inventoryStrategy,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}
