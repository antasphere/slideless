# The Slideless renderer (PRDCT-2725): a sandboxed Chromium behind a
# one-endpoint queue, the one place Slideless opens user-authored HTML.
# Build from the REPO ROOT: docker build -f apps/renderer/Dockerfile .
# Run it under deploy/seccomp-chromium.json: Docker's default profile forbids
# the user namespaces Chromium's own sandbox needs, and the renderer refuses
# to start (exit 3) rather than run Chromium unsandboxed.

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/renderer/package.json apps/renderer/package.json
RUN pnpm install --frozen-lockfile --filter @slideless/renderer

COPY apps/renderer apps/renderer
RUN pnpm --filter @slideless/renderer build \
 && pnpm --filter @slideless/renderer deploy --prod --legacy /out

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw
# Chromium's shared libraries and fonts; tini as PID 1 (Chromium forks, and
# the renderer SIGKILLs a browser at every capture's end).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 \
      libxkbcommon0 libatspi2.0-0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libexpat1 libglib2.0-0 \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /out /app
WORKDIR /app

# The headless shell only (no full Chrome, no ffmpeg), installed as root at
# build and linked at one fixed path (its binary is `headless_shell` under
# chrome-linux/ on arm64 and `chrome-headless-shell` under
# chrome-headless-shell-linux64/ on amd64); then the runtime never invokes a
# package manager, so npm, yarn and corepack go (PLT-35 + PRDCT-1346).
RUN node /app/node_modules/playwright-core/cli.js install chromium-headless-shell \
 && shell="$(find /opt/pw -type f \( -name headless_shell -o -name chrome-headless-shell \) -perm -u+x | head -n 1)" \
 && test -n "$shell" \
 && ln -s "$shell" /usr/local/bin/chromium-headless-shell \
 && rm -rf /opt/pw/ffmpeg-* /root/.npm /root/.cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/lib/node_modules/corepack /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

ENV NODE_ENV=production \
    PORT=3100 \
    RENDERER_CHROMIUM_PATH=/usr/local/bin/chromium-headless-shell

USER node
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=5s --retries=5 --start-period=30s \
  CMD node dist/healthcheck.js

LABEL org.opencontainers.image.title="slideless-renderer" \
      org.opencontainers.image.description="The Slideless renderer: a sandboxed Chromium that makes each deck version's still image"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
