import { Role } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { CuttingController } from '../cutting/cutting.controller';
import { DashboardController } from '../sales/dashboard.controller';
import { QuotationsService } from '../sales/quotations.service';
import { AppThrottlerGuard, isLoginRoute } from './throttler.guard';

/**
 * cc57 — P3 de higiene de audit-01: permisos declarados (C-06, C-07), la cubeta por correo solo en
 * el login (C-08) y la auditoría del vencimiento de cotizaciones (B-09).
 */
const rolesOf = (target: object, method: string): unknown =>
  Reflect.getMetadata(ROLES_KEY, (target as Record<string, unknown>)[method] as object);

describe('cc57 (C-06, C-07): roles declarados', () => {
  it('el stock de flejes es de administrador y supervisor de planta, sin @Roles() vacío', () => {
    expect(rolesOf(CuttingController.prototype, 'stripStock')).toEqual([
      Role.ADMINISTRADOR,
      Role.SUPERVISOR_PLANTA,
    ]);
  });

  it('el panel del vendedor es del vendedor y del administrador', () => {
    expect(rolesOf(DashboardController.prototype, 'getDashboard')).toEqual([
      Role.VENDEDOR,
      Role.ADMINISTRADOR,
    ]);
  });
});

describe('cc57 (C-08): la cubeta por correo, solo en el login', () => {
  const tracker = (path: string, body: unknown, ip = '10.0.0.1') =>
    new (
      AppThrottlerGuard as unknown as new () => {
        getTracker: (req: unknown) => Promise<string>;
      }
    )().getTracker({ path, body, ip });

  it('reconoce el login con y sin el prefijo', () => {
    expect(isLoginRoute({ path: '/api/auth/login' })).toBe(true);
    expect(isLoginRoute({ path: '/auth/login' })).toBe(true);
    expect(isLoginRoute({ path: '/api/customers' })).toBe(false);
  });

  it('el login va por correo; el alta de un cliente con correo, por IP', async () => {
    await expect(tracker('/api/auth/login', { email: ' A@B.pe ' })).resolves.toBe('email|a@b.pe');
    await expect(tracker('/api/customers', { email: 'a@b.pe' })).resolves.toBe('10.0.0.1');
  });
});

describe('cc57 (B-09): el vencimiento de cotizaciones audita las que vencieron de verdad', () => {
  it('nombra solo las que el filtro de estado tocó', async () => {
    const write = jest.fn();
    const tx = {
      quotation: {
        // Se leyeron dos; entre medio, una se confirmó y el filtro la deja fuera.
        updateManyAndReturn: jest.fn().mockResolvedValue([{ seq: 7 }]),
      },
    };
    const svc = Object.create(QuotationsService.prototype) as QuotationsService;
    Object.assign(svc, {
      prisma: {
        quotation: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'q7', seq: 7 },
            { id: 'q8', seq: 8 },
          ]),
        },
        $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      },
      audit: { write },
      logger: { log: jest.fn() },
    });
    await expect(svc.expireDue()).resolves.toBe(1);
    expect(write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ after: { count: 1, codes: ['COT-000007'] } }),
    );
  });
});

describe('cc57 (B-08): el producto de coberturas se lee con la transacción del llamador', () => {
  it('usa el cliente que recibe, no el del servicio', async () => {
    const { ProductionService } = await import('../production/production.service');
    const svc = Object.create(ProductionService.prototype) as InstanceType<
      typeof ProductionService
    >;
    Object.assign(svc, {
      prisma: { product: { findUnique: jest.fn().mockRejectedValue(new Error('otra conexión')) } },
    });
    const product = {
      id: 'p1',
      sku: 'COB',
      thicknessMm: '0.40',
      widthMm: '1000',
      finish: { id: 'f1', code: 'F', densityFactor: '8', isActive: true },
    };
    const tx = { product: { findUnique: jest.fn().mockResolvedValue(product) } };
    await expect(svc.requireRoofingProduct('p1', tx as never)).resolves.toMatchObject({
      sku: 'COB',
    });
    expect(tx.product.findUnique).toHaveBeenCalled();
  });
});
