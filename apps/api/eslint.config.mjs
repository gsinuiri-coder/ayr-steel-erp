import nest from '@ayr/eslint-config/nest.mjs';

export default [...nest, { ignores: ['dist/**', 'prisma/migrations/**'] }];
