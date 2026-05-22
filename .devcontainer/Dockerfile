# Base: official Microsoft dev container for Python 3.11.
# Includes git, build tools, sudo, and a non-root `vscode` user with
# passwordless sudo — saves us re-creating any of that here.
FROM mcr.microsoft.com/devcontainers/python:1-3.11-bookworm

# psql for `make doctor` / inspection queries; libpq-dev so asyncpg
# wheels that fall back to source builds don't fail; postgresql-15
# provides /usr/lib/postgresql/15/bin/pg_ctl so the pytest-postgresql
# fixture can spawn an ephemeral cluster (DB-touching tests). The
# package only installs the server binaries — the operator's data
# still lives in Supabase / the configured DATABASE_URL, not in this
# container. make drives the repo's Makefile.
#
# The base image ships an apt source for dl.yarnpkg.com whose GPG
# key has rotated, causing `apt-get update` to exit 100. Yarn is not
# used here, so drop the source before refreshing the index.
RUN rm -f /etc/apt/sources.list.d/yarn.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-client \
        postgresql-15 \
        libpq-dev \
        make \
    && rm -rf /var/lib/apt/lists/*

# uv: workspace + venv manager. Copy the prebuilt binaries from the
# official image rather than running the installer script — pinning
# is explicit and the layer is small.
COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /usr/local/bin/
