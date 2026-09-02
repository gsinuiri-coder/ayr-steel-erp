# Imagen del API (apps/api) para Cloud Run. Contexto de build = raíz del monorepo.
# Etapa 1: dependencias + build
FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.13.2 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @ayr/api... --filter @ayr/shared...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @ayr/shared build && pnpm --filter @ayr/api build
# Solo dependencias de producción, desplegadas en una carpeta autocontenida
RUN pnpm --filter @ayr/api --prod deploy /out
# pnpm deploy deja un stub de .prisma/client: se copia el cliente generado en el build
RUN SRC=$(ls -d /repo/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma) \
  && DST=$(ls -d /out/node_modules/.pnpm/@prisma+client@*/node_modules) \
  && rm -rf "$DST/.prisma" && cp -R "$SRC" "$DST/.prisma"

# Etapa 2: runtime mínimo, usuario no root
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
USER node
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/main.js"]
