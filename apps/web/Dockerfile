# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

# Unlike every service image — which runs TypeScript directly through tsx and deliberately has
# NO build step — the storefront is a real Vite build: the browser receives static assets, not
# source. @ecom/contracts still comes in as TypeScript source, exactly as the services consume
# it, so Vite resolves it through its `main: src/index.ts`.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @ecom/web build

FROM nginx:alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
