# syntax=docker/dockerfile:1
# eidan-on-matbot host image. Runs the matbot CLI in server mode with the full eidan core plugin
# set (storage-postgres, vault-postgres, llm-calls, memory, auth, notify, jobs, frontend-agui,
# mcp-server, a2a-server, procedures, secrets-api). Node 24 runs the TypeScript sources directly.
# One image deploys to every node; per-node env (EIDAN_JOB_KINDS, ports, routes) tunes the role.
FROM node:24-slim

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# 1) matbot runtime (vendored submodule) — install its own pnpm workspace.
COPY external/matbot/ ./external/matbot/
RUN cd external/matbot && pnpm install --config.engine-strict=false

# isolated-vm (used by @eidandev/procedures for the sandbox) is a native addon — when no prebuilt
# binary matches the platform, building it needs a C++ toolchain. (Follow-on: multi-stage build to
# keep these out of the final image.)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Marp CLI for @eidandev/charles-decks (render_deck). HTML output needs no browser; pptx/pdf would
# additionally require headless Chromium (not installed here — keep the image lean), so decks render
# to HTML on this node.
RUN npm i -g @marp-team/marp-cli@^4

# 2) eidan core plugins (+ the migrate runner) — pg + symlinks to the vendored plugin-api.
COPY packages/ ./packages/
COPY migrations/ ./migrations/
# plugin doc overlays (rich READMEs for vendored matbot plugins; read by frontend-agui /api/plugins)
COPY docs/plugins/ ./docs/plugins/
COPY infra/fly-mb/host-package.json ./package.json
COPY infra/fly-mb/host-pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN pnpm install --config.engine-strict=false

# 3) host config (plugins + provider; secrets arrive via env: EIDAN_DATABASE_URL, ANTHROPIC_API_KEY).
COPY infra/fly-mb/matbot.yaml ./matbot.yaml

# The deployed eidan version (the in-image ./package.json is a 0.0.0 host stub, so the engine can't
# read it from there). The deploy CLI passes --build-arg EIDAN_VERSION=<root package.json version>;
# telemetry surfaces it in node_heartbeats.metadata for the web version indicator.
ARG EIDAN_VERSION=dev
ENV EIDAN_VERSION=${EIDAN_VERSION}

# AG-UI :8090, inbound MCP :8091, secure secrets API :8092, inbound A2A :8095. A worker-only node
# needs none of these exposed.
ENV MATBOT_AGUI_PORT=8090 MATBOT_MCP_PORT=8091 MATBOT_SECRETS_PORT=8092 MATBOT_A2A_PORT=8095
EXPOSE 8090 8091 8092 8095
CMD ["node", "--import", "./external/matbot/apps/cli/register.js", "./external/matbot/apps/cli/src/index.ts", "start", "--config", "./matbot.yaml"]
