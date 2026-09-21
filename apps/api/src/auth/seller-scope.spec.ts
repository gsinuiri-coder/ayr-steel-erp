import { NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { assertSellerAccess, quotationSellerWhere, sellerWhere } from './seller-scope';
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

describe('política de alcance RF-S3c', () => {
  it('filtra pedidos y cotizaciones de un vendedor, y deja pasar al administrador', () => {
    expect(sellerWhere(seller)).toEqual({ sellerId: seller.id });
    expect(quotationSellerWhere(seller)).toEqual({ sellerId: seller.id });
    expect(sellerWhere(admin)).toEqual({});
    expect(quotationSellerWhere(admin)).toEqual({});
  });

  it('presenta un recurso ajeno como inexistente', () => {
    expect(() => { assertSellerAccess(seller, 'seller-b', 'Pedido'); }).toThrow(NotFoundException);
    expect(() => { assertSellerAccess(seller, null, 'Pedido'); }).toThrow(NotFoundException);
    expect(() => { assertSellerAccess(seller, seller.id, 'Pedido'); }).not.toThrow();
    expect(() => { assertSellerAccess(admin, 'seller-b', 'Pedido'); }).not.toThrow();
  });
});
