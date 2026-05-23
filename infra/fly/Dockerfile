# Tracked, generic Fly.io image for the eidan backend.
#
# An operator deploys from a vanilla clone of upstream eidan — no
# files are edited, no fork is required. Per-deploy choices come in
# as build args + Fly secrets (see docs/DEPLOYMENT.md §4).
#
# Build args:
#   EIDAN_BUNDLES        comma-separated bundle slugs to install before
#                        the image is sealed (e.g. "eidan-pro,eidan-lifestyle").
#                        Empty (default) = core-only deploy.
#   EIDAN_PLUGIN_SOURCE  passed straight to `eidan plugin install` and
#                        must be set when EIDAN_BUNDLES is non-empty.
#                        Form is `gh:<org>` (private GitHub org) or
#                        `local:<path>` for development copies that
#                        landed in the build context.
#
# Build secret (Buildx --secret form so the PAT is never baked into
# an image layer):
#   id=github_token      personal access token / fine-grained token
#                        with `repo` scope on the bundle repos.
#                        Required iff EIDAN_PLUGIN_SOURCE starts with
#                        `gh:`. Read at install time via
#                        `EIDAN_GITHUB_TOKEN` (re-exported below).
#
# Typical invocation from a clean checkout:
#
#   fly deploy -c $YOUR_FLY_TOML --dockerfile infra/fly/Dockerfile \
#     --build-arg EIDAN_BUNDLES=eidan-pro,eidan-lifestyle \
#     --build-arg EIDAN_PLUGIN_SOURCE=gh:sielay \
#     --build-secret id=github_token,src=$HOME/.eidan/github-token
#
# Runtime secrets (DATABASE_URL, EIDAN_AUTH_MASTER_KEY, provider
# credentials, …) are set via `fly secrets set` and are NOT build
# args — see docs/DEPLOYMENT.md §4.4 and §6.

FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_CACHE_DIR=/tmp/uv-cache

# git is needed at install time for the gh: bundle source path;
# keeping it in the final image is fine — bundle re-installs at
# runtime (Phase 3 on the roadmap) will lean on it too.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv

WORKDIR /app

# Copy the workspace shape the in-repo CLI + backend expect. The
# `plugins/` copy carries the tier:core plugins shipped with this
# repo; bundle plugins (paid) are added by the install step below.
COPY pyproject.toml uv.lock ./
COPY apps ./apps
COPY plugins ./plugins
COPY packages ./packages
COPY migrations ./migrations

RUN uv sync --frozen --no-dev

# Optional bundle install. No-op when EIDAN_BUNDLES is empty (the
# default), so a core-only build behaves exactly like the historical
# Dockerfile. When non-empty, the build secret mounts the token at
# /run/secrets/github_token and we re-export it as EIDAN_GITHUB_TOKEN
# for the CLI; --no-migrate is set because the database isn't
# reachable from the build sandbox (the runtime lifespan + the
# operator's explicit `eidan admin db migrate` cover migration).
ARG EIDAN_BUNDLES=""
ARG EIDAN_PLUGIN_SOURCE=""
RUN --mount=type=secret,id=github_token,required=false \
    if [ -n "$EIDAN_BUNDLES" ]; then \
        if [ -z "$EIDAN_PLUGIN_SOURCE" ]; then \
            echo "EIDAN_BUNDLES is set but EIDAN_PLUGIN_SOURCE is empty; see infra/fly/Dockerfile header." >&2; \
            exit 2; \
        fi; \
        if [ -f /run/secrets/github_token ]; then \
            export EIDAN_GITHUB_TOKEN="$(cat /run/secrets/github_token)"; \
        fi; \
        export EIDAN_PLUGIN_INSTALL_NO_MIGRATE=1; \
        export EIDAN_PLUGIN_SOURCE; \
        for bundle in $(echo "$EIDAN_BUNDLES" | tr ',' ' '); do \
            uv run eidan admin plugin install "$bundle" --force; \
        done; \
    fi

EXPOSE 8000
CMD ["uv", "run", "eidan", "admin", "server", "--host", "0.0.0.0", "--port", "8000"]
