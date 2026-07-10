# ---- build ----------------------------------------------------------------
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo

# Install with a full workspace context so pnpm can resolve workspace: deps.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/contract/package.json packages/contract/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN pnpm install --frozen-lockfile

COPY packages ./packages
COPY apps ./apps

# Dashboard builds straight into apps/server/public (adapter-static config),
# then the server compiles, then pnpm deploy prunes a production-only bundle.
# pnpm deploy honors the server package's "files" (dist + public), so the
# runtime gets exactly the built artifacts plus pruned prod node_modules.
# @platform/sdk is built BEFORE the dashboard: the dashboard imports it and its
# package `exports` resolve to `dist` (so the built CLI runs standalone), and
# `.dockerignore` strips any host-built `dist` from the context.
RUN pnpm --filter @platform/db build \
 && pnpm --filter @platform/contract build \
 && pnpm --filter @platform/sdk build \
 && pnpm --filter @platform/dashboard build \
 && pnpm --filter @platform/server build \
 && pnpm --filter @platform/server deploy --prod --legacy /out \
 && cp -r packages/db/drizzle /out/drizzle

# Prune build-time tooling that pnpm's peer resolution drags into the prod
# tree: drizzle-kit (migrations ship pre-generated, applied via drizzle-orm)
# pulls esbuild's Go binaries — the CVE source — plus typescript. The
# deny-list lives in scripts/prune-runtime-deps.mjs, which removes the
# packages AND verifies the result in the same run, so removal and
# verification cannot drift: it fails THIS BUILD on any dangling symlink it
# cannot attribute to the deny-list, on any surviving deny-listed copy, on
# any declared dependency that no longer resolves, and on
# `node dist/index.js --boot-check`, which loads the full static runtime
# import graph (better-auth → kysely etc.). A dependency bump that makes a
# pruned package runtime-reachable therefore breaks the image build — not
# container boot.
COPY scripts/prune-runtime-deps.mjs scripts/prune-runtime-deps.mjs
RUN node scripts/prune-runtime-deps.mjs /out

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine
# The runtime runs `node dist/index.js` and never invokes npm — remove the
# npm that ships bundled in the base image (its vendored deps carry CVEs and
# add weight). tini + wget are the only OS additions we keep.
RUN apk add --no-cache tini wget \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
ENV NODE_ENV=production
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

COPY --from=build --chown=node:node /out /app

USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
  CMD wget --spider -q "http://localhost:${PORT:-3000}/healthz" || exit 1

LABEL org.opencontainers.image.title="platform" \
      org.opencontainers.image.description="Self-hosted platform (API + dashboard + MCP) in one image" \
      org.opencontainers.image.version=$APP_VERSION

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
