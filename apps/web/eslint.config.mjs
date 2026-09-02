import next from '@ayr/eslint-config/next.mjs';

export default [...next, { ignores: ['.next/**', 'next-env.d.ts', 'src/components/ui/**'] }];
