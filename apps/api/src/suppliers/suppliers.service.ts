import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Supplier } from '@prisma/client';
import type { CreateSupplierInput, SupplierDto, UpdateSupplierInput } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/** Proveedores (RF-81, RF-83). Mutaciones solo ADMINISTRADOR (guard en el controller). */
@Injectable()
export class SuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(): Promise<SupplierDto[]> {
    const suppliers = await this.prisma.supplier.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return suppliers.map(toDto);
  }

  async findOne(id: string): Promise<SupplierDto> {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    return toDto(supplier);
  }

  async create(actor: RequestUser, input: CreateSupplierInput): Promise<SupplierDto> {
    try {
      const supplier = await this.prisma.$transaction(async (tx) => {
        const created = await tx.supplier.create({
          data: {
            code: input.code,
            docType: input.docType,
            docNumber: input.docNumber,
            name: input.name,
            address: input.address,
            email: input.email,
            phone: input.phone,
            creditDays: input.creditDays,
            providesCuttingService: input.providesCuttingService,
          },
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'suppliers.create',
          entity: 'suppliers',
          entityId: created.id,
          after: auditView(created),
        });
        return created;
      });
      return toDto(supplier);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(
          'Ya existe un proveedor con ese documento o con ese código corto',
        );
      }
      throw err;
    }
  }

  async update(actor: RequestUser, id: string, input: UpdateSupplierInput): Promise<SupplierDto> {
    const before = await this.prisma.supplier.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Proveedor no encontrado');

    const data: Prisma.SupplierUpdateInput = {};
    if (input.code !== undefined) data.code = input.code;
    if (input.name !== undefined) data.name = input.name;
    if (input.address !== undefined) data.address = input.address;
    if (input.email !== undefined) data.email = input.email;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.creditDays !== undefined) data.creditDays = input.creditDays;
    if (input.providesCuttingService !== undefined)
      data.providesCuttingService = input.providesCuttingService;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.supplier.update({ where: { id }, data });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'suppliers.update',
        entity: 'suppliers',
        entityId: id,
        before: auditView(before),
        after: auditView(updated),
      });
      return updated;
    });
    return toDto(after);
  }
}

function toDto(s: Supplier): SupplierDto {
  return {
    id: s.id,
    code: s.code,
    docType: s.docType,
    docNumber: s.docNumber,
    name: s.name,
    address: s.address,
    email: s.email,
    phone: s.phone,
    creditDays: s.creditDays,
    providesCuttingService: s.providesCuttingService,
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function auditView(s: Supplier): Prisma.InputJsonObject {
  return {
    code: s.code,
    docType: s.docType,
    docNumber: s.docNumber,
    name: s.name,
    creditDays: s.creditDays,
    providesCuttingService: s.providesCuttingService,
    isActive: s.isActive,
  };
}
