/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  // RF-S4b: la raíz de jest es la del repo, y las `roots` acotan qué se recorre. Los tests de la
  // API cargan `@ayr/shared` desde su **fuente**, no desde `dist/`, con dos consecuencias buscadas:
  // (1) la cobertura del paquete entra al mismo `lcov` que la de la API —no tiene runner propio y
  // SonarCloud lo cuenta como código sin cobertura, que es lo que hundió el gate de código nuevo
  // del PR #14—, y (2) desaparece la trampa de correr jest contra un `dist/` viejo tras editar
  // `packages/shared/src` (hallazgo P2 de la autorrevisión de D-249). Con la raíz en el repo, los
  // `SF:` del lcov salen como `apps/api/src/…` y `packages/shared/src/…`, que es como SonarCloud
  // los resuelve desde la raíz del proyecto.
  rootDir: '../..',
  roots: ['<rootDir>/apps/api/src', '<rootDir>/packages/shared/src'],
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/apps/api/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@ayr/shared$': '<rootDir>/packages/shared/src/index.ts',
  },
  collectCoverageFrom: [
    'apps/api/src/**/*.ts',
    '!apps/api/src/main.ts',
    'packages/shared/src/**/*.ts',
  ],
  coverageDirectory: '<rootDir>/apps/api/coverage',
  testEnvironment: 'node',
};
