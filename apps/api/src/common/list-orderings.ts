import type { Prisma } from '@prisma/client';
import type {
  CoilQuery,
  CustomerQuery,
  DispatchQuery,
  FiscalDocumentQuery,
  PurchaseQuery,
  QuotationQuery,
  SalesOrderQuery,
} from '@ayr/shared';
import { listOrderBy } from './list-sort';

/**
 * D-323: el `orderBy` de cada listado paginado a partir de `?sort=&dir=`, con el orden de siempre
 * (D-113/D-124) como desempate. Solo columnas propias de la fila o del cliente/proveedor de una
 * relación directa; una columna derivada (un saldo, el estado mostrado) no es una clave.
 * Viven acá, y no dentro de cada servicio, para poder probar cada clave sin armar el servicio.
 */

export function quotationOrderBy(
  query: Pick<QuotationQuery, 'sort' | 'dir'>,
): Prisma.QuotationOrderByWithRelationInput[] {
  return listOrderBy<NonNullable<QuotationQuery['sort']>, Prisma.QuotationOrderByWithRelationInput>(
    query,
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
