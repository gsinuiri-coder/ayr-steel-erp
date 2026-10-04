import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isLockConflict, LOCK_CONFLICT_MESSAGE, LockConflictFilter } from './lock-conflict.filter';

/**
 * D-386 (M3b): un deadlock (`40P01`) o un fallo de serialización (`40001`) sale como 409 con el
 * mensaje en español; todo lo demás, igual que antes. La forma real del error de Prisma contra
 * Postgres la prueba `lock-order.db-spec.ts` provocando un deadlock de verdad.
 */
const known = (code: string, meta?: Record<string, unknown>, message = 'x') =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: '6', meta });

describe('isLockConflict', () => {
  it.each([
    ['P2034 del cliente tipado', known('P2034')],
    ['P2010 de $queryRaw con 40P01', known('P2010', { code: '40P01' })],
    ['P2010 de $queryRaw con 40001', known('P2010', { code: '40001' })],
    [
      'desconocido con el texto de Postgres',
      new Prisma.PrismaClientUnknownRequestError('ERROR: deadlock detected', {
        clientVersion: '6',
      }),
    ],
  ])('reconoce %s', (_label, error) => {
    expect(isLockConflict(error)).toBe(true);
  });

  it.each([
    ['P2002 (único)', known('P2002')],
    ['P2010 con otro código de Postgres', known('P2010', { code: '23505' })],
    ['un error de dominio', new BadRequestException('no')],
    ['un Error suelto que menciona deadlock', new Error('deadlock detected')],
    // Segundo modelo P3-3: un correlativo con «40001» no es un fallo de serialización.
    ['un P2002 cuyo mensaje trae un correlativo 40001', known('P2002', {}, 'F001-40001 duplicado')],
    ['un P2010 cuyo mensaje trae 40001 sin código', known('P2010', {}, 'F001-40001 duplicado')],
  ])('no confunde %s', (_label, error) => {
    expect(isLockConflict(error)).toBe(false);
  });
});

describe('LockConflictFilter', () => {
  function run(exception: unknown) {
    const reply = jest.fn();
    const adapter = {
      reply,
      isHeadersSent: () => false,
      end: jest.fn(),
    };
    const filter = new LockConflictFilter(adapter as never);
    const host = {
      getType: () => 'http',
      getArgByIndex: () => ({}),
      getArgs: () => [{}, {}],
      switchToHttp: () => ({ getResponse: () => ({}), getRequest: () => ({}) }),
    } as unknown as ArgumentsHost;
    filter.catch(exception, host);
    return reply.mock.calls[0] as [unknown, { statusCode: number; message: string }, number];
  }

  it('un deadlock sale como 409 con el mensaje en español, sin reintento', () => {
    const [, body, status] = run(known('P2010', { code: '40P01' }));
    expect(status).toBe(409);
    expect(body.message).toBe(LOCK_CONFLICT_MESSAGE);
  });

  it('un error de dominio sale igual que antes', () => {
    const [, body, status] = run(new BadRequestException('Stock insuficiente'));
    expect(status).toBe(400);
    expect(body.message).toBe('Stock insuficiente');
  });
});
