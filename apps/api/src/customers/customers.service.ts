import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Customer } from '@prisma/client';
import {
  Role,
  type CreateCustomerInput,
  type CustomerDto,
  type UpdateCustomerInput,
} from '@ayr/shared';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Clientes (RF-80, RF-82, RF-85).
 *
 * D-076 cambió quién puede qué: **VENDEDOR crea y edita datos básicos**; siguen siendo de
 * ADMINISTRADOR los tres campos con consecuencia fuera del maestro —el documento (es la
 * identidad fiscal con la que sale el comprobante), los días de crédito (definen el
 * vencimiento de una cuenta por cobrar, D-075) y la baja lógica (esconde al cliente de
 * todo el sistema)—. El guard del controller deja pasar a los dos roles; **la separación
 * fina se hace acá**, campo por campo, porque un guard de ruta no puede verla.
 */
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

    // D-077: el cliente sembrado es inmutable. Editarlo cambiaría la identidad con la que
    // sale toda boleta a público en general; darlo de baja dejaría sin destinatario a una
    // venta de mostrador que el sistema sí admite.
    if (before.isSystem) {
      throw new BadRequestException(
        'El cliente "público en general" es del sistema: no se edita ni se da de baja',
      );
    }

    // D-076: los campos reservados a ADMINISTRADOR. Se comprueban por campo y no por ruta
    // porque el vendedor sí puede llamar a este endpoint, solo que con menos alcance.
    if (actor.role !== Role.ADMINISTRADOR) {
      if (input.creditDays !== undefined && input.creditDays !== before.creditDays) {
        throw new ForbiddenException(
          'Los días de crédito los cambia un administrador: definen el vencimiento de las cuentas por cobrar',
        );
      }
      if (input.isActive !== undefined && input.isActive !== before.isActive) {
        throw new ForbiddenException('Dar de alta o de baja a un cliente es de un administrador');
      }
    }

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
    isSystem: c.isSystem,
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
