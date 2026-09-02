import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Customer } from '@prisma/client';
import type { CreateCustomerInput, CustomerDto, UpdateCustomerInput } from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/** Clientes (RF-80, RF-82). Mutaciones solo ADMINISTRADOR (guard en el controller). */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findAll(): Promise<CustomerDto[]> {
    const customers = await this.prisma.customer.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });
    return customers.map(toDto);
  }

  async findOne(id: string): Promise<CustomerDto> {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    return toDto(customer);
  }

  async create(actor: RequestUser, input: CreateCustomerInput): Promise<CustomerDto> {
    try {
      const customer = await this.prisma.$transaction(async (tx) => {
        const created = await tx.customer.create({
          data: {
            docType: input.docType,
            docNumber: input.docNumber,
            name: input.name,
            address: input.address,
            email: input.email,
            phone: input.phone,
            creditDays: input.creditDays,
          },
        });
        await this.audit.write(tx, {
          actorId: actor.id,
          action: 'customers.create',
          entity: 'customers',
          entityId: created.id,
          after: auditView(created),
        });
        return created;
      });
      return toDto(customer);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ya existe un cliente activo con ese documento');
      }
      throw err;
    }
  }

  async update(actor: RequestUser, id: string, input: UpdateCustomerInput): Promise<CustomerDto> {
    const before = await this.prisma.customer.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Cliente no encontrado');

    const data: Prisma.CustomerUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.address !== undefined) data.address = input.address;
    if (input.email !== undefined) data.email = input.email;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.creditDays !== undefined) data.creditDays = input.creditDays;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({ where: { id }, data });
      await this.audit.write(tx, {
        actorId: actor.id,
        action: 'customers.update',
        entity: 'customers',
        entityId: id,
        before: auditView(before),
        after: auditView(updated),
      });
      return updated;
    });
    return toDto(after);
  }
}

function toDto(c: Customer): CustomerDto {
  return {
    id: c.id,
    docType: c.docType,
    docNumber: c.docNumber,
    name: c.name,
    address: c.address,
    email: c.email,
    phone: c.phone,
    creditDays: c.creditDays,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function auditView(c: Customer): Prisma.InputJsonObject {
  return {
    docType: c.docType,
    docNumber: c.docNumber,
    name: c.name,
    creditDays: c.creditDays,
    isActive: c.isActive,
  };
}
