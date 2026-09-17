import { Reflector } from '@nestjs/core';
import { Role } from '@ayr/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { CatalogController } from './catalog.controller';

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
