import base from './base.mjs';
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
      // D-112 (Fase 7d): cortar un timestamp con `.slice(0, 10)` lo lee en UTC. Lima va
      // cinco horas detrás, así que todo lo ocurrido después de las 19:00 locales se
      // mostraba fechado al día siguiente — el defecto que M-4 encontró en nueve pantallas
      // y que ya existía en el formulario de tipo de cambio. Usar `formatTimestampDate`
      // (o `businessToday()` para "hoy") de `@ayr/shared`/`@/lib/format`.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='slice'][arguments.0.value=0][arguments.1.value=10][callee.object.property.name=/At$/]",
          message:
            'No cortes un timestamp con slice(0, 10): lee en UTC, no en Lima (D-112). Usa formatTimestampDate() de @/lib/format.',
        },
        {
          selector:
            "CallExpression[callee.property.name='slice'][arguments.0.value=0][arguments.1.value=10][callee.object.callee.property.name='toISOString']",
          message:
            'No cortes toISOString() con slice(0, 10) para "hoy": lee en UTC, no en Lima (D-112). Usa businessToday() de @ayr/shared.',
        },
      ],
    },
  },
  { ignores: ['.next/**', 'next-env.d.ts', 'src/components/ui/**'] },
];
