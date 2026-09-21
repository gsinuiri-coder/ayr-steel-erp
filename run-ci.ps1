pnpm --filter @ayr/shared build
pnpm --filter @ayr/api db:generate
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:scripts
pnpm --filter @ayr/api test:cov
pnpm --filter @ayr/web test:cov
