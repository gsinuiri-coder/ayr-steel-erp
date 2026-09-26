import { Reflector } from '@nestjs/core';
import { Role } from '@ayr/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import type { RequestUser } from '../auth/auth.types';
import type { CoilFilmService } from './coil-film.service';
import type { CoilOperationsService } from './coil-operations.service';
import { CoilsController } from './coils.controller';
import type { CoilsService } from './coils.service';

/**
 * D-328 — las tres rutas nuevas del film (`GET film-events`, `POST film/open`, `POST
 * film/reseal`): a quién se abren y que delegan tal cual en el servicio, con el actor.
 */

const ACTOR = { id: 'u1', role: Role.ADMINISTRADOR } as unknown as RequestUser;
const ID = '11111111-1111-4111-8111-111111111111';

function build() {
  const coils = { findFilmEvents: jest.fn().mockResolvedValue(['evento']) };
  const operations = {};
  const film = {
    open: jest.fn().mockResolvedValue({ film: 'OPENED' }),
    reseal: jest.fn().mockResolvedValue({ film: 'SEALED' }),
  };
  const controller = new CoilsController(
    coils as unknown as CoilsService,
    operations as unknown as CoilOperationsService,
    film as unknown as CoilFilmService,
  );
  return { controller, coils, film };
}

describe('CoilsController — film de protección (D-328)', () => {
  const reflector = new Reflector();

  it('el módulo entero es de ADMINISTRADOR y SUPERVISOR_PLANTA (las rutas del film no lo abren más)', () => {
    expect(reflector.get<Role[]>(ROLES_KEY, CoilsController)).toEqual([
      Role.ADMINISTRADOR,
      Role.SUPERVISOR_PLANTA,
    ]);
    for (const method of ['openFilm', 'resealFilm', 'findFilmEvents'] as const) {
      // Ninguna ruta del film redefine los roles: heredan los del controlador.
      expect(reflector.get<Role[]>(ROLES_KEY, CoilsController.prototype[method])).toBeUndefined();
    }
  });

  it('el historial sale del servicio de bobinas', async () => {
    const { controller, coils } = build();
    await expect(controller.findFilmEvents(ID)).resolves.toEqual(['evento']);
    expect(coils.findFilmEvents).toHaveBeenCalledWith(ID);
  });

  it('abrir y volver a sellar delegan en el servicio del film con el actor y el cuerpo', async () => {
    const { controller, film } = build();
    const body = { reason: 'para usarla' };
    await expect(controller.openFilm(ACTOR, ID, body)).resolves.toEqual({ film: 'OPENED' });
    await expect(controller.resealFilm(ACTOR, ID, body)).resolves.toEqual({ film: 'SEALED' });
    expect(film.open).toHaveBeenCalledWith(ACTOR, ID, body);
    expect(film.reseal).toHaveBeenCalledWith(ACTOR, ID, body);
  });
});
