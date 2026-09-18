import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BusinessLine, Role } from '@ayr/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { CatalogController } from './catalog.controller';
import type { CatalogService } from './catalog.service';

/**
 * RF-S3/cierre (hallazgo de `revisor`): `GET /catalog/price-list/floor-summary` se había
 * quedado sin `@Roles(Role.ADMINISTRADOR)` — el control era solo del lado del cliente
 * (`enabled: isAdmin` en la card), que no protege nada. Un test de metadata, no de HTTP: el
 * guard real (`RolesGuard`) lee esta misma metadata con `Reflector`, así que confirmar que
 * está puesta es confirmar que el guard la va a exigir — sin levantar toda la app para un
 * 403.
 */
describe('CatalogController — roles por ruta', () => {
  const reflector = new Reflector();

  it('findPriceListFloorSummary exige ADMINISTRADOR', () => {
    const roles = reflector.get<Role[] | undefined>(
      ROLES_KEY,
      CatalogController.prototype.findPriceListFloorSummary,
    );
    expect(roles).toEqual([Role.ADMINISTRADOR]);
  });
});

describe('CatalogController — endpoints RF-S3', () => {
  const catalog = {
    search: jest.fn(),
    findPriceListFloorSummary: jest.fn(),
  };
  const controller = new CatalogController(catalog as unknown as CatalogService);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delega la búsqueda sin filtro y con una línea de negocio válida', async () => {
    catalog.search.mockResolvedValue([]);

    await controller.search({ q: 'bobina' });
    await controller.search({ q: 'bobina' }, BusinessLine.METALLIC_ROOFING);

    expect(catalog.search).toHaveBeenNthCalledWith(1, 'bobina', undefined);
    expect(catalog.search).toHaveBeenNthCalledWith(2, 'bobina', BusinessLine.METALLIC_ROOFING);
  });

  it('rechaza una línea de negocio desconocida en vez de ignorarla', () => {
    expect(() => controller.search({ q: 'bobina' }, 'metallic-roofng')).toThrow(
      BadRequestException,
    );
    expect(catalog.search).not.toHaveBeenCalled();
  });

  it('delega el resumen del piso de precios', async () => {
    const summary = { totalWithListPrice: 0, withoutFloor: 0, belowFloor: [] };
    catalog.findPriceListFloorSummary.mockResolvedValue(summary);

    await expect(controller.findPriceListFloorSummary()).resolves.toBe(summary);
  });
});
