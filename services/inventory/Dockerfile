# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# Runtime executes the TypeScript entrypoint directly via tsx (see CMD), so there
# is NO tsc build step: @ecom/shared and @ecom/contracts are consumed as source
# through their package `main: src/index.ts`. A full install is used (not
# `--filter @ecom/inventory...`) because tsx lives in the ROOT devDependencies.
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/inventory ./services/inventory
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ecom/inventory exec prisma generate

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/services/inventory
EXPOSE 3001
CMD ["pnpm", "exec", "tsx", "src/main.ts"]
