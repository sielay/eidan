# syntax=docker/dockerfile:1
# eidan-on-matbot host image. Runs the matbot CLI in server mode with the full eidan core plugin
# set (storage-postgres, llm-calls, memory, auth, notify, jobs, frontend-agui, mcp-server,
# a2a-server). Node 24 runs the TypeScript sources directly (native type-stripping) — no build step.
# One image deploys to every node; per-node env (EIDAN_JOB_KINDS, ports, routes) tunes the role.
FROM node:24-slim

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# 1) matbot runtime (vendored submodule) — install its own pnpm workspace.
COPY external/matbot/ ./external/matbot/
RUN cd external/matbot && pnpm install --config.engine-strict=false

# 2) eidan core plugins (+ the migrate runner) — pg + symlinks to the vendored plugin-api.
COPY packages/ ./packages/
COPY migrations/ ./migrations/
COPY infra/fly-mb/host-package.json ./package.json
COPY infra/fly-mb/host-pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm install --config.engine-strict=false

# 3) host config (plugins + provider; secrets arrive via env: EIDAN_DATABASE_URL, ANTHROPIC_API_KEY).
COPY infra/fly-mb/matbot.yaml ./matbot.yaml

# AG-UI :8090, inbound MCP :8091, inbound A2A :8095. A worker-only node needs none of these exposed.
ENV MATBOT_AGUI_PORT=8090 MATBOT_MCP_PORT=8091 MATBOT_A2A_PORT=8095
EXPOSE 8090 8091 8095
CMD ["node", "--import", "./external/matbot/apps/cli/register.js", "./external/matbot/apps/cli/src/index.ts", "start", "--config", "./matbot.yaml"]
