import { Reflector } from '@nestjs/core';
import { invoiceDispatchDateSchema, Role } from '@ayr/shared';
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

  it('D-364 delega la fecha elegida tanto en preview como en ejecución', async () => {
    const invoiceDispatch = {
      preview: jest.fn().mockResolvedValue({ lines: [] }),
      executeForInvoice: jest.fn().mockResolvedValue({ dispatchIds: [] }),
    };
    const controller = new DispatchesController({} as never, {} as never, invoiceDispatch as never);
    const actor = { id: 'admin', role: Role.ADMINISTRADOR } as never;

    await controller.previewAtIssueDate(actor, '00000000-0000-4000-8000-000000000001', {
      dispatchDate: '2026-09-29',
    });
    await controller.executeAtIssueDate(actor, '00000000-0000-4000-8000-000000000001', {
      dispatchDate: '2026-09-29',
    });

    expect(invoiceDispatch.preview).toHaveBeenCalledWith(
      actor,
      '00000000-0000-4000-8000-000000000001',
      '2026-09-29',
    );
    expect(invoiceDispatch.executeForInvoice).toHaveBeenCalledWith(
      actor,
      '00000000-0000-4000-8000-000000000001',
      '2026-09-29',
    );
  });

  it('D-364 rechaza una fecha de operación que no existe antes de planificar', () => {
    expect(invoiceDispatchDateSchema.safeParse({ dispatchDate: '2026-09-31' }).success).toBe(false);
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
