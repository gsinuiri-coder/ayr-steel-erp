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
      ...reactHooks.configs.recommended.rules,
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
