import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role, type User } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import type { RequestUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

const admin: RequestUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@ayr.test',
  name: 'Admin',
  role: Role.ADMINISTRADOR,
  mustChangePassword: false,
  sessionId: 's-admin',
};

const vendedor: User = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'vendedor@ayr.test',
  name: 'Vendedor',
  passwordHash: 'hash',
  role: Role.VENDEDOR,
  active: true,
  mustChangePassword: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('UsersService (RF-03/RF-04)', () => {
  let service: UsersService;
  const prisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const auth = {
    revokeAllSessions: jest.fn().mockResolvedValue(1),
    hashPassword: jest.fn().mockResolvedValue('h'),
  };
  const audit = {
    log: jest.fn().mockResolvedValue(undefined),
    write: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // La transacción ejecuta el callback con el mismo mock como `tx`.
    prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.user.count.mockResolvedValue(1);
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: auth },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('cambiar el rol invalida las sesiones del usuario', async () => {
    prisma.user.findUnique.mockResolvedValue(vendedor);
    prisma.user.update.mockResolvedValue({ ...vendedor, role: Role.SUPERVISOR_PLANTA });
    await service.update(admin, vendedor.id, { role: Role.SUPERVISOR_PLANTA });
    expect(auth.revokeAllSessions).toHaveBeenCalledWith(vendedor.id);
    expect(audit.write).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: 'users.role.change' }),
    );
  });

  it('desactivar invalida las sesiones del usuario', async () => {
    prisma.user.findUnique.mockResolvedValue(vendedor);
    prisma.user.update.mockResolvedValue({ ...vendedor, active: false });
    await service.deactivate(admin, vendedor.id);
    expect(auth.revokeAllSessions).toHaveBeenCalledWith(vendedor.id);
    expect(audit.write).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: 'users.deactivate' }),
    );
  });

  it('editar solo el nombre no invalida sesiones', async () => {
    prisma.user.findUnique.mockResolvedValue(vendedor);
    prisma.user.update.mockResolvedValue({ ...vendedor, name: 'Nuevo' });
    await service.update(admin, vendedor.id, { name: 'Nuevo' });
    expect(auth.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('resetear contraseña fuerza cambio y revoca sesiones', async () => {
    prisma.user.findUnique.mockResolvedValue(vendedor);
    prisma.user.update.mockResolvedValue(vendedor);
    await service.update(admin, vendedor.id, { password: 'NuevaClave1' });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { passwordHash: 'h', mustChangePassword: true } }),
    );
    expect(auth.revokeAllSessions).toHaveBeenCalledWith(vendedor.id);
  });

  it('la mutación y su auditoría van en la misma transacción', async () => {
    prisma.user.findUnique.mockResolvedValue(vendedor);
    prisma.user.update.mockResolvedValue(vendedor);
    await service.update(admin, vendedor.id, { name: 'Otro' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: 'users.update' }),
    );
  });

  it('un administrador no puede desactivarse a sí mismo', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...vendedor,
      id: admin.id,
      role: Role.ADMINISTRADOR,
    });
    await expect(service.update(admin, admin.id, { active: false })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('un administrador no puede cambiar su propio rol', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...vendedor,
      id: admin.id,
      role: Role.ADMINISTRADOR,
    });
    await expect(service.update(admin, admin.id, { role: Role.VENDEDOR })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('no permite desactivar ni degradar al último administrador activo', async () => {
    const otherAdmin = {
      ...vendedor,
      id: '33333333-3333-4333-8333-333333333333',
      role: Role.ADMINISTRADOR,
    };
    prisma.user.findUnique.mockResolvedValue(otherAdmin);
    prisma.user.count.mockResolvedValue(0);
    await expect(service.update(admin, otherAdmin.id, { active: false })).rejects.toThrow(
      'último administrador',
    );
    await expect(service.update(admin, otherAdmin.id, { role: Role.VENDEDOR })).rejects.toThrow(
      'último administrador',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('crea usuario con mustChangePassword=true', async () => {
    prisma.user.create.mockResolvedValue({ ...vendedor, mustChangePassword: true });
    const dto = await service.create(admin, {
      email: 'nuevo@ayr.test',
      name: 'Nuevo',
      role: Role.VENDEDOR,
      password: 'Temporal123',
    });
    expect(dto.mustChangePassword).toBe(true);
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: true }) }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ action: 'users.create' }),
    );
  });
});
