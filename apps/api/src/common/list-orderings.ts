import type { Prisma } from '@prisma/client';
import {
  compareImportedInvoiceNumbers,
  importedInvoiceNumber,
  type CoilQuery,
  type CustomerQuery,
  type DispatchQuery,
  type FiscalDocumentQuery,
  type PurchaseQuery,
  type QuotationQuery,
  type SalesOrderQuery,
  type SortDirection,
} from '@ayr/shared';
import { listOrderBy } from './list-sort';

/**
 * D-323: el `orderBy` de cada listado paginado a partir de `?sort=&dir=`, con el orden de siempre
 * (D-113/D-124) como desempate. Solo columnas propias de la fila o del cliente/proveedor de una
 * relación directa; una columna derivada (un saldo, el estado mostrado) no es una clave.
 * Viven acá, y no dentro de cada servicio, para poder probar cada clave sin armar el servicio.
 */

/**
 * D-387: `invoice` no tiene fragmento de `orderBy` (el número vive en las observaciones): con esa
 * clave queda el orden de siempre y `QuotationsService.findAll` ordena con
 * `orderByImportedInvoice`.
 */
export function quotationOrderBy(
  query: Pick<QuotationQuery, 'sort' | 'dir'>,
): Prisma.QuotationOrderByWithRelationInput[] {
  type DbKey = Exclude<NonNullable<QuotationQuery['sort']>, 'invoice'>;
  return listOrderBy<DbKey, Prisma.QuotationOrderByWithRelationInput>(
    { sort: query.sort === 'invoice' ? undefined : query.sort, dir: query.dir },
    {
      code: (d) => ({ seq: d }),
      customer: (d) => ({ customer: { name: d } }),
      issueDate: (d) => ({ issueDate: d }),
      total: (d) => ({ totalPen: d }),
      status: (d) => ({ status: d }),
    },
    [{ seq: 'desc' }],
  );
}

/**
 * D-387: la lista de cotizaciones ordenada por el comprobante importado. Las importadas van
 * primero en los dos sentidos —serie y correlativo como número, `compareImportedInvoiceNumbers`—
 * y las demás detrás; el número de cotización descendente desempata, como el orden de siempre.
 */
export function orderByImportedInvoice<T extends { seq: number; notes: string | null }>(
  rows: readonly T[],
  dir: SortDirection = 'asc',
): T[] {
  const sign = dir === 'desc' ? -1 : 1;
  return rows
    .map((row) => ({ row, invoice: importedInvoiceNumber(row.notes) }))
    .sort((a, b) => {
      if (a.invoice !== null && b.invoice !== null) {
        const byInvoice = compareImportedInvoiceNumbers(a.invoice, b.invoice);
        if (byInvoice !== 0) return sign * byInvoice;
      } else if (a.invoice !== b.invoice) {
        return a.invoice === null ? 1 : -1;
      }
      return b.row.seq - a.row.seq;
    })
    .map(({ row }) => row);
}

export function salesOrderOrderBy(
  query: Pick<SalesOrderQuery, 'sort' | 'dir'>,
): Prisma.SalesOrderOrderByWithRelationInput[] {
  return listOrderBy<
    NonNullable<SalesOrderQuery['sort']>,
    Prisma.SalesOrderOrderByWithRelationInput
  >(
    query,
    {
      code: (d) => ({ seq: d }),
      customer: (d) => ({ customer: { name: d } }),
      issueDate: (d) => ({ issueDate: d }),
      total: (d) => ({ totalPen: d }),
    },
    [{ seq: 'desc' }],
  );
}

export function coilOrderBy(
  query: Pick<CoilQuery, 'sort' | 'dir'>,
): Prisma.CoilOrderByWithRelationInput[] {
  return listOrderBy<NonNullable<CoilQuery['sort']>, Prisma.CoilOrderByWithRelationInput>(
    query,
    { code: (d) => ({ code: d }), status: (d) => ({ status: d }) },
    // Revisión independiente (A-2): el `id` al final hace único el desempate, así una fila no se
    // repite ni se pierde entre páginas cuando muchas empatan en la columna.
    [{ operationDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  );
}

export function customerOrderBy(
  query: Pick<CustomerQuery, 'sort' | 'dir'>,
): Prisma.CustomerOrderByWithRelationInput[] {
  return listOrderBy<NonNullable<CustomerQuery['sort']>, Prisma.CustomerOrderByWithRelationInput>(
    query,
    {
      docNumber: (d) => ({ docNumber: d }),
      name: (d) => ({ name: d }),
      creditDays: (d) => ({ creditDays: d }),
      // Activos primero en ascendente: `true` va después de `false` al ordenar de menor a mayor.
      status: (d) => ({ isActive: d === 'asc' ? 'desc' : 'asc' }),
    },
    [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
  );
}

export function purchaseOrderBy(
  query: Pick<PurchaseQuery, 'sort' | 'dir'>,
): Prisma.PurchaseOrderByWithRelationInput[] {
  return listOrderBy<NonNullable<PurchaseQuery['sort']>, Prisma.PurchaseOrderByWithRelationInput>(
    query,
    {
      number: (d) => [{ series: d }, { number: d }],
      supplier: (d) => ({ supplier: { name: d } }),
      type: (d) => ({ type: d }),
      issueDate: (d) => ({ issueDate: d }),
      dueDate: (d) => ({ dueDate: d }),
      total: (d) => ({ totalPen: d }),
      status: (d) => ({ status: d }),
    },
    [{ issueDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  );
}

export function fiscalDocumentOrderBy(
  query: Pick<FiscalDocumentQuery, 'sort' | 'dir'>,
): Prisma.FiscalDocumentOrderByWithRelationInput[] {
  return listOrderBy<
    NonNullable<FiscalDocumentQuery['sort']>,
    Prisma.FiscalDocumentOrderByWithRelationInput
  >(
    query,
    {
      number: (d) => ({ number: d }),
      docType: (d) => ({ docType: d }),
      customer: (d) => ({ customer: { name: d } }),
      issueDate: (d) => ({ issueDate: d }),
      dueDate: (d) => ({ dueDate: d }),
      total: (d) => ({ totalPen: d }),
      status: (d) => ({ status: d }),
    },
    [{ issueDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  );
}

export function dispatchOrderBy(
  query: Pick<DispatchQuery, 'sort' | 'dir'>,
): Prisma.DispatchOrderByWithRelationInput[] {
  return listOrderBy<NonNullable<DispatchQuery['sort']>, Prisma.DispatchOrderByWithRelationInput>(
    query,
    {
      code: (d) => ({ seq: d }),
      order: (d) => ({ salesOrder: { seq: d } }),
      customer: (d) => ({ salesOrder: { customer: { name: d } } }),
      date: (d) => ({ dispatchDate: d }),
      weight: (d) => ({ totalWeightKg: d }),
      status: (d) => ({ status: d }),
    },
    [{ dispatchDate: 'desc' }, { seq: 'desc' }],
  );
}
