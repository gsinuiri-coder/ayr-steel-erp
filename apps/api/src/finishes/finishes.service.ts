import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Finish } from '@prisma/client';
import type { CreateFinishInput, FinishDto, UpdateFinishInput } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/** Acabados de bobina (RF-25). Mutaciones solo ADMINISTRADOR (guard en el controller). */
@Injectable()
export class FinishesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(): Promise<FinishDto[]> {
    const finishes = await this.prisma.finish.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return finishes.map(toDto);
  }

  async findOne(id: string): Promise<FinishDto> {
    const finish = await this.prisma.finish.findUnique({ where: { id } });
    if (!finish) throw new NotFoundException('Acabado no encontrado');
    return toDto(finish);
  }

  async create(actor: RequestUser, input: CreateFinishInput): Promise<FinishDto> {
    try {
      const finish = await this.prisma.$transaction(async (tx) => {
        const created = await tx.finish.create({
          data: { code: input.code, name: input.name, densityFactor: input.densityFactor },
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'finishes.create',
          entity: 'finishes',
          entityId: created.id,
          after: auditView(created),
        });
        return created;
      });
      return toDto(finish);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ya existe un acabado con ese código');
      }
      throw err;
    }
  }

  async update(actor: RequestUser, id: string, input: UpdateFinishInput): Promise<FinishDto> {
    const before = await this.prisma.finish.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Acabado no encontrado');

    const data: Prisma.FinishUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.densityFactor !== undefined) data.densityFactor = input.densityFactor;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.finish.update({ where: { id }, data });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'finishes.update',
        entity: 'finishes',
        entityId: id,
        before: auditView(before),
        after: auditView(updated),
      });
      return updated;
    });
    return toDto(after);
  }
}

function toDto(f: Finish): FinishDto {
  return {
    id: f.id,
    code: f.code,
    name: f.name,
    densityFactor: f.densityFactor.toFixed(4),
    isActive: f.isActive,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

function auditView(f: Finish): Prisma.InputJsonObject {
  return {
    code: f.code,
    name: f.name,
    densityFactor: f.densityFactor.toFixed(4),
    isActive: f.isActive,
  };
}
