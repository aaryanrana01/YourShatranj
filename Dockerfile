# ---- Stage 1: install everything, compile TypeScript, build the web app.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

# Copy only the package manifests first. Docker caches this layer, so
# dependencies are reinstalled only when a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps ./apps
RUN pnpm build

# ---- Stage 2: production dependencies only (no compilers, no dev tools, ~45 MB).
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# "@chess/server..." = the server and the workspace packages it depends on.
RUN pnpm install --prod --frozen-lockfile --filter "@chess/server..."

# ---- Stage 3: the image that actually runs.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    WEB_DIST=/app/web
WORKDIR /app

# Same folder layout as the repo, so pnpm's workspace links keep working.
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/web/dist ./web

# Never run as root inside the container.
USER node
WORKDIR /app/apps/server
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
# Database migrations run automatically at startup (src/db/migrate.ts).
CMD ["node", "dist/index.js"]
