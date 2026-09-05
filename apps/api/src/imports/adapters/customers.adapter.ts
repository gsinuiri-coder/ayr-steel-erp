import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createCustomerSchema, ImportEntity } from '@ayr/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  getField,
  type ImportColumn,
  type RowImportAdapter,
  type RowValidation,
} from './import-adapter.interface';

const COLUMNS = {
  docType: { key: 'docType', header: 'Tipo de documento (DNI/RUC/CE)', required: true },
  docNumber: { key: 'docNumber', header: 'Número de documento', required: true },
  name: { key: 'name', header: 'Nombre / razón social', required: true },
  address: { key: 'address', header: 'Dirección', required: false },
  email: { key: 'email', header: 'Correo', required: false },
  phone: { key: 'phone', header: 'Teléfono', required: false },
  creditDays: { key: 'creditDays', header: 'Días de crédito', required: false },
} satisfies Record<string, ImportColumn>;

/** Adaptador de importación de clientes (RF-52). */
@Injectable()
export class CustomersImportAdapter implements RowImportAdapter {
  entity = ImportEntity.CUSTOMERS;
  columns = Object.values(COLUMNS);

  constructor(private readonly prisma: PrismaService) {}

  async validateRow(raw: Record<string, unknown>): Promise<RowValidation> {
    const docType = getField(raw, COLUMNS.docType).toUpperCase();
    const docNumber = getField(raw, COLUMNS.docNumber);
    const name = getField(raw, COLUMNS.name);
    const address = getField(raw, COLUMNS.address);
    const email = getField(raw, COLUMNS.email);
    const phone = getField(raw, COLUMNS.phone);
    const creditDaysRaw = getField(raw, COLUMNS.creditDays);

    const errors: string[] = [];
    const parsed = createCustomerSchema.safeParse({
      docType,
      docNumber,
      name,
      address: address || undefined,
      email: email || undefined,
      phone: phone || undefined,
      creditDays: creditDaysRaw || '0',
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(issue.message);
    }

    if (docType && docNumber) {
      const dup = await this.prisma.customer.findFirst({
        where: { docType: docType as never, docNumber },
      });
      if (dup) errors.push(`Ya existe un cliente con ${docType} ${docNumber}`);
    }

    return {
      data: parsed.success
        ? parsed.data
        : { docType, docNumber, name, address, email, phone, creditDays: creditDaysRaw },
      errors,
    };
  }

  dedupeKey(data: Record<string, unknown>): string | undefined {
    const docType = data.docType as string | undefined;
    const docNumber = data.docNumber as string | undefined;
    return docType && docNumber ? `${docType}:${docNumber}` : undefined;
  }

  async createEntity(tx: Prisma.TransactionClient, data: Record<string, unknown>): Promise<string> {
    const created = await tx.customer.create({
      data: {
        docType: data.docType as Prisma.CustomerCreateInput['docType'],
        docNumber: data.docNumber as string,
        name: data.name as string,
        address: (data.address as string | null) ?? null,
        email: (data.email as string | null) ?? null,
        phone: (data.phone as string | null) ?? null,
        creditDays: data.creditDays as number,
      },
    });
    return created.id;
  }
}
