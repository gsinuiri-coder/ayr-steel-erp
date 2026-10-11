import base from './base.mjs';
import { businessDateRules } from './business-date.mjs';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  ...base,
  {
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // D-606 (cc46): las dos reglas clásicas, explícitas y como error. `configs.recommended.rules`
      // de la v6 es `undefined` (el preset es un arreglo de configs planas) y las reglas nunca se
      // activaron. Las del React Compiler (`refs`, `set-state-in-effect`, …) quedan fuera.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      // D-112 (Fase 7d): los selectores viven en `business-date.mjs` desde D-131, porque la
      // misma regla tiene que valer también en `e2e/` (ver `eslint.config.mjs` de la raíz).
      'no-restricted-syntax': ['error', ...businessDateRules],
    },
  },
  { ignores: ['.next/**', 'next-env.d.ts', 'src/components/ui/**'] },
];
