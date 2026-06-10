# syntax=docker/dockerfile:1
# eidan-on-matbot host image. Runs the matbot CLI in server mode with the eidan
# plugins (storage-postgres + memory) and the matbot web frontend. Node 24 runs
# the TypeScript sources directly (native type-stripping) — no build step.
FROM node:24-slim

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# 1) matbot runtime (vendored submodule) — install its own pnpm workspace.
COPY external/matbot/ ./external/matbot/
RUN cd external/matbot && pnpm install --config.engine-strict=false

# 2) eidan plugins — pg + a symlink to the submodule's plugin-api (link: dep).
COPY packages/storage-postgres/ ./packages/storage-postgres/
COPY packages/memory/ ./packages/memory/
COPY infra/fly-mb/host-package.json ./package.json
COPY infra/fly-mb/host-pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm install --config.engine-strict=false

# 3) host config (plugins + provider; secrets arrive via env: EIDAN_DATABASE_URL, ANTHROPIC_API_KEY).
COPY infra/fly-mb/matbot.yaml ./matbot.yaml

ENV MATBOT_WEB_PORT=8080
EXPOSE 8080
CMD ["node", "--import", "./external/matbot/apps/cli/register.js", "./external/matbot/apps/cli/src/index.ts", "start"]
