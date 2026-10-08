import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateInvoiceInput } from '@ayr/shared';
import type { RequestUser } from '../auth/auth.types';
import { InvoicingService } from './invoicing.service';

/**
 * cc33 N2 y N4 — `createInTx` revisa el pedido **antes de escribir**, con su fila ya bloqueada: el
 * alcance del vendedor (N2, 404 sin borrador), y el estado y el cliente en la cabecera aunque el
 * comprobante solo tenga líneas libres (N4).
 */
const SELLER_A = { id: 'seller-a', role: 'VENDEDOR' } as RequestUser;
const SELLER_B = { id: 'seller-b', role: 'VENDEDOR' } as RequestUser;

const INPUT = {
  docType: 'FACTURA',
  customerId: 'c-1',
  salesOrderId: 'o-1',
  issueDate: '2026-10-08',
  paymentTerms: 'CONTADO',
  items: [{ description: 'Flete', qty: '1', unit: 'NIU', unitPricePen: '10.0000' }],
} as unknown as CreateInvoiceInput;

function build(order: { sellerId: string | null; status: string; customerId: string }) {
  const create = jest.fn();
  const customerFind = jest.fn().mockResolvedValue({
    id: 'c-1',
    isActive: true,
    isSystem: false,
    docType: 'RUC',
    name: 'Cliente',
    creditDays: 0,
  });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'o-1' }]),
    salesOrder: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ totalPen: new Prisma.Decimal('100'), seq: 12, ...order }),
    },
    customer: { findUnique: customerFind },
    fiscalDocument: { create },
  };
  const svc = new InvoicingService(
    {} as never,
    { write: jest.fn() } as never,
    {} as never,
    {} as never,
    { assertIssueDate: jest.fn() } as never,
    {} as never,
    { PSE_ENABLED: false } as never,
    {} as never,
  );
  return { svc, tx, create, customerFind };
}

describe('InvoicingService.createInTx — el pedido antes de escribir (cc33 N2, N4)', () => {
  it('N2: el vendedor de otro pedido recibe 404 sin llegar a leer el cliente ni a escribir', async () => {
    const { svc, tx, create, customerFind } = build({
      sellerId: SELLER_A.id,
      status: 'CONFIRMED',
      customerId: 'c-1',
    });
    await expect(svc.createInTx(tx as never, SELLER_B, INPUT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(customerFind).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('N2: un pedido sin vendedor tampoco es del vendedor', async () => {
    const { svc, tx, create } = build({ sellerId: null, status: 'CONFIRMED', customerId: 'c-1' });
    await expect(svc.createInTx(tx as never, SELLER_B, INPUT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('N4: un pedido anulado se rechaza aunque solo haya líneas libres', async () => {
    const { svc, tx, create } = build({
      sellerId: SELLER_A.id,
      status: 'CANCELLED',
      customerId: 'c-1',
    });
    const err = svc.createInTx(tx as never, SELLER_A, INPUT);
    await expect(err).rejects.toBeInstanceOf(BadRequestException);
    await expect(err).rejects.toThrow('PED-000012 está anulado');
    expect(create).not.toHaveBeenCalled();
  });

  it('N4: un pedido de otro cliente se rechaza aunque solo haya líneas libres', async () => {
    const { svc, tx, create } = build({
      sellerId: SELLER_A.id,
      status: 'CONFIRMED',
      customerId: 'c-2',
    });
    await expect(svc.createInTx(tx as never, SELLER_A, INPUT)).rejects.toThrow(
      'clientes distintos',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('el pedido propio, vivo y del mismo cliente sigue hasta leer el cliente', async () => {
    const { svc, tx, customerFind } = build({
      sellerId: SELLER_A.id,
      status: 'CONFIRMED',
      customerId: 'c-1',
    });
    // Más adelante faltan mocks (líneas, topes); alcanza con ver que pasó las comprobaciones.
    await svc.createInTx(tx as never, SELLER_A, INPUT).catch(() => undefined);
    expect(customerFind).toHaveBeenCalled();
  });
});
