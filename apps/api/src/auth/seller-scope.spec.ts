import { NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  assertSellerAccess,
  quotationSellerWhere,
  resolveOrderSeller,
  sellerWhere,
} from './seller-scope';
import type { RequestUser } from './auth.types';

const seller: RequestUser = {
  id: 'seller-a',
  email: 'seller-a@test.local',
  name: 'Vendedor A',
  role: Role.VENDEDOR,
  mustChangePassword: false,
  sessionId: 'session-a',
};
const admin: RequestUser = { ...seller, id: 'admin', role: Role.ADMINISTRADOR };
const planta: RequestUser = { ...seller, id: 'planta', role: Role.SUPERVISOR_PLANTA };

describe('política de alcance RF-S3c', () => {
  it('filtra pedidos y cotizaciones de un vendedor, y deja pasar al administrador y otros roles', () => {
    expect(sellerWhere(seller)).toEqual({ sellerId: seller.id });
    expect(quotationSellerWhere(seller)).toEqual({ sellerId: seller.id });
    expect(sellerWhere(admin)).toEqual({});
    expect(quotationSellerWhere(admin)).toEqual({});
    expect(sellerWhere(planta)).toEqual({});
    expect(quotationSellerWhere(planta)).toEqual({});
  });

  it('presenta un recurso ajeno como inexistente solo para VENDEDOR', () => {
    expect(() => {
      assertSellerAccess(seller, 'seller-b', 'Pedido');
    }).toThrow(NotFoundException);
    expect(() => {
      assertSellerAccess(seller, null, 'Pedido');
    }).toThrow(NotFoundException);
    expect(() => {
      assertSellerAccess(seller, seller.id, 'Pedido');
    }).not.toThrow();
    expect(() => {
      assertSellerAccess(admin, 'seller-b', 'Pedido');
    }).not.toThrow();
    expect(() => {
      assertSellerAccess(planta, 'seller-b', 'Pedido');
    }).not.toThrow();
  });
});

// D-240. Centinela de la regla que comparten `SalesOrdersService.confirmQuotation` y el
// backfill de `seller_id`. El caso que da nombre al primer test es el defecto que se corrigió
// antes de la ventana S3c: derivar el dueño del pedido de su creador dejaba fuera del alcance
// del vendedor todo pedido que hubiera confirmado un administrador.
describe('resolveOrderSeller (D-240)', () => {
  it('un ADMINISTRADOR confirma la cotización de un vendedor y el pedido queda del vendedor', () => {
    expect(
      resolveOrderSeller({
        quotation: { sellerId: 'seller-a', createdById: 'seller-a' },
        createdById: admin.id,
      }),
    ).toBe('seller-a');
  });

  it('cae al creador de la cotización cuando la cotización todavía no tiene dueño', () => {
    expect(
      resolveOrderSeller({
        quotation: { sellerId: null, createdById: 'seller-b' },
        createdById: admin.id,
      }),
    ).toBe('seller-b');
  });

  it('respeta una reasignación M4: el pedido sigue al nuevo dueño de la cotización', () => {
    expect(
      resolveOrderSeller({
        quotation: { sellerId: 'seller-b', createdById: 'seller-a' },
        createdById: 'seller-a',
      }),
    ).toBe('seller-b');
  });

  it('el pedido directo, sin cotización, pertenece a quien lo creó', () => {
    expect(resolveOrderSeller({ quotation: null, createdById: 'seller-a' })).toBe('seller-a');
    expect(resolveOrderSeller({ quotation: null, createdById: admin.id })).toBe(admin.id);
  });

  it('nunca devuelve el confirmador cuando hay cotización de por medio', () => {
    const resultado = resolveOrderSeller({
      quotation: { sellerId: 'seller-a', createdById: 'seller-a' },
      createdById: planta.id,
    });
    expect(resultado).not.toBe(planta.id);
  });
});
