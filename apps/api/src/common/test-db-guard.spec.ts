import { assertTestDatabase } from '../../prisma/test-db-guard';

/**
 * El guard de la base de pruebas (D-018/D-181). Desde cc18 admite también las bases hermanas
 * locales `ayr_local_e2e_<sufijo>`, para que dos sesiones no se vacíen la misma base; sigue sin
 * admitir nada que no sea local, y las dos URLs tienen que ser la **misma** base.
 */
const local = (name: string, host = '127.0.0.1') => `postgresql://u:p@${host}:5434/${name}`;

describe('assertTestDatabase', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function withUrls(databaseUrl: string, directUrl?: string) {
    process.env.ALLOW_DB_RESET = '1';
    process.env.DATABASE_URL = databaseUrl;
    if (directUrl === undefined) delete process.env.DIRECT_URL;
    else process.env.DIRECT_URL = directUrl;
    return () => assertTestDatabase();
  }

  it.each(['ayr_local_e2e', 'ayr_local_e2e_cc18', 'ayr_local_e2e_x1'])(
    'admite %s local',
    (name) => {
      expect(withUrls(local(name), local(name))()).toContain(name);
    },
  );

  it.each(['ayr_local', 'ayr_local_e2e_', 'ayr_local_e2e_CC18', 'ayr_local_e2e-cc18', 'otra'])(
    'rechaza %s',
    (name) => {
      expect(withUrls(local(name))).toThrow('Bloqueado');
    },
  );

  it('rechaza una base hermana fuera de localhost', () => {
    expect(withUrls(local('ayr_local_e2e_cc18', 'db.example.com'))).toThrow('Bloqueado');
  });

  it('rechaza dos bases hermanas distintas en DATABASE_URL y DIRECT_URL', () => {
    expect(withUrls(local('ayr_local_e2e_cc18'), local('ayr_local_e2e'))).toThrow(
      'bases de pruebas distintas',
    );
  });

  it('sin ALLOW_DB_RESET no admite nada', () => {
    const run = withUrls(local('ayr_local_e2e'));
    delete process.env.ALLOW_DB_RESET;
    expect(run).toThrow('ALLOW_DB_RESET');
  });
});
