# ---- build ----------------------------------------------------------------
FROM node:26-alpine AS build
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
# @slideless/sdk is built BEFORE the dashboard: the dashboard imports it and its
# package `exports` resolve to `dist` (so the built CLI runs standalone), and
# `.dockerignore` strips any host-built `dist` from the context.
RUN pnpm --filter @slideless/db build \
 && pnpm --filter @slideless/contract build \
 && pnpm --filter @slideless/sdk build \
 && pnpm --filter @slideless/dashboard build \
 && pnpm --filter @slideless/server build \
 && pnpm --filter @slideless/server deploy --prod --legacy /out \
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
FROM node:26-alpine
# The runtime runs `node dist/index.js` and never invokes a package manager —
# remove npm, yarn and corepack that ship bundled in the base image (their
# vendored deps carry CVEs and add weight; PLT-35 + PRDCT-1346). tini + wget
# are the only OS additions we keep. `apk upgrade` first pulls the base
# image's OS packages up to Alpine's current fixes: the Trivy HIGH gate in
# release.yml scans this final stage, and the node:22-alpine tag lags the
# Alpine security feed (same pattern as the hub, 2026-08-28).
RUN apk upgrade --no-cache && apk add --no-cache tini wget \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
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

LABEL org.opencontainers.image.title="slideless" \
      org.opencontainers.image.description="Self-hosted Slideless (API + dashboard + MCP) in one image" \
      org.opencontainers.image.version=$APP_VERSION

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
