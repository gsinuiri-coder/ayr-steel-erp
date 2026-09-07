import { businessDateRules } from '@ayr/eslint-config/business-date.mjs';
import tseslint from 'typescript-eslint';

/**
 * Lint de la raíz: hoy, solo `e2e/`.
 *
 * Existe por D-131. Los paquetes tienen su propia config (`apps/api`, `apps/web`,
 * `packages/shared`), pero la suite E2E vive fuera de todos ellos y no la miraba nadie — y
 * ahí había dieciséis lugares cortando `toISOString()` en UTC, exactamente lo que D-112
 * había prohibido en el web. Los encontró CI cuando D-124 empezó a validar contra Lima.
 *
 * A propósito **no** es type-aware: `e2e/` no tiene un `tsconfig` propio, y las reglas de
 * D-112 son selectores de AST que no necesitan tipos. Poner la config estricta entera acá
 * habría costado un `tsconfig` más y una corrida de lint lenta para cubrir una regla.
 */
export default [
  {
    files: ['e2e/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    // El plugin se registra aunque no se active ninguna de sus reglas: `e2e/` tiene
    // comentarios `eslint-disable` que nombran reglas suyas, y sin el plugin cargado ESLint
    // los reporta como "regla no encontrada" — un error que no dice nada sobre el código.
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { 'no-restricted-syntax': ['error', ...businessDateRules] },
  },
];
