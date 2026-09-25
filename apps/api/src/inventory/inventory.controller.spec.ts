import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { Role } from '@ayr/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { InventoryController } from './inventory.controller';
import type { InventoryService } from './inventory.service';

// D-290: el buscador de ítems del kardex es de lectura y de los mismos roles que el kardex.
describe('InventoryController — buscador de ítems', () => {
  const reflector = new Reflector();
  const rolesOf = (method: keyof InventoryController) =>
    reflector.get<Role[]>(ROLES_KEY, InventoryController.prototype[method]);

  it('solo ADMINISTRADOR y SUPERVISOR_PLANTA (no VENDEDOR, que no ve costos de compra)', () => {
    expect(rolesOf('searchItems')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
    expect(rolesOf('resolveItem')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
    expect(rolesOf('findMovements')).toEqual([Role.ADMINISTRADOR, Role.SUPERVISOR_PLANTA]);
  });

  it('delega en el servicio con el texto y con el ítem', async () => {
    const inventory = {
      searchItems: jest.fn().mockResolvedValue([{ code: 'BOB-1' }]),
      resolveItem: jest.fn().mockResolvedValue({ code: 'BOB-1' }),
    };
    const controller = new InventoryController(inventory as unknown as InventoryService);
    await expect(controller.searchItems({ q: 'bob' })).resolves.toEqual([{ code: 'BOB-1' }]);
    expect(inventory.searchItems).toHaveBeenCalledWith('bob');
    const query = { itemType: 'COIL' as const, itemId: '00000000-0000-4000-8000-000000000001' };
    await controller.resolveItem(query);
    expect(inventory.resolveItem).toHaveBeenCalledWith(query);
  });
});
