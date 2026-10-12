import { HealthController, deployedSha } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';

describe('health (D-636)', () => {
  it('devuelve el sha de GIT_SHA, o «dev» sin la variable', () => {
    expect(deployedSha({ GIT_SHA: 'abc1234' })).toBe('abc1234');
    expect(deployedSha({ GIT_SHA: '  abc1234\n' })).toBe('abc1234');
    expect(deployedSha({})).toBe('dev');
    expect(deployedSha({ GIT_SHA: '' })).toBe('dev');
  });

  it('el health lleva el sha junto al estado de la base', async () => {
    const prev = process.env.GIT_SHA;
    process.env.GIT_SHA = 'e28853a5';
    try {
      const prisma = { $queryRaw: jest.fn().mockResolvedValue([1]) } as unknown as PrismaService;
      const res = await new HealthController(prisma).check();
      expect(res).toMatchObject({ status: 'ok', db: 'ok', sha: 'e28853a5' });
    } finally {
      if (prev === undefined) delete process.env.GIT_SHA;
      else process.env.GIT_SHA = prev;
    }
  });
});
