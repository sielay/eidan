# syntax=docker/dockerfile:1
# eidan reference UI (Next.js, standalone output). Build context = apps/web. The browser talks only
# to this app (the same-origin front door); it proxies chat/auth to the engine (EIDAN_ENGINE_URL)
# and reads Postgres directly for dashboards. Runtime env: EIDAN_ENGINE_URL, EIDAN_DATABASE_URL,
# EIDAN_AUTH_JWT_SECRET, EIDAN_AUTH_ALLOWED_EMAIL, EIDAN_SMTP_* (optional).
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --config.engine-strict=false
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Same-origin: bake an empty public base so all /api/* calls stay first-party.
ENV NEXT_PUBLIC_EIDAN_BACKEND_URL=""
RUN pnpm build

FROM node:24-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3001 HOSTNAME=0.0.0.0
# Next standalone bundles only what the server needs.
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
EXPOSE 3001
CMD ["node", "server.js"]
