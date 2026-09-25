import { Reflector } from '@nestjs/core';
import { Role } from '@ayr/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { DispatchesController } from './dispatches.controller';

/**
 * D-287 (P2-3 de la revisión de segundo modelo): la vista previa de «Despachar a la fecha del
 * comprobante» exige ADMINISTRADOR igual que la ejecución. Test de metadata, como en
 * `catalog.controller.spec.ts`: `RolesGuard` lee esta misma metadata con `Reflector`.
 */
describe('DispatchesController — roles del despacho a la fecha del comprobante', () => {
  const reflector = new Reflector();

  it.each([
    ['previewAtIssueDate', DispatchesController.prototype.previewAtIssueDate],
    ['executeAtIssueDate', DispatchesController.prototype.executeAtIssueDate],
  ])('%s exige ADMINISTRADOR', (_name, handler) => {
    expect(reflector.get<Role[] | undefined>(ROLES_KEY, handler)).toEqual([Role.ADMINISTRADOR]);
  });

  it('el resto del controlador sigue abierto a planta y ventas (D-074)', () => {
    expect(reflector.get<Role[] | undefined>(ROLES_KEY, DispatchesController)).toEqual([
      Role.ADMINISTRADOR,
      Role.VENDEDOR,
      Role.SUPERVISOR_PLANTA,
    ]);
  });
});

describe('DispatchesController — despachos enlazados (D-288)', () => {
  it('linkedAtIssueDate exige ADMINISTRADOR y delega en el servicio', async () => {
    expect(
      new Reflector().get<Role[] | undefined>(
        ROLES_KEY,
        DispatchesController.prototype.linkedAtIssueDate,
      ),
    ).toEqual([Role.ADMINISTRADOR]);
    const invoiceDispatch = { linkedDispatches: jest.fn().mockResolvedValue({ dispatches: [] }) };
    const controller = new DispatchesController({} as never, {} as never, invoiceDispatch as never);
    expect(await controller.linkedAtIssueDate('F1')).toEqual({ dispatches: [] });
    expect(invoiceDispatch.linkedDispatches).toHaveBeenCalledWith('F1');
  });
});
