.PHONY: help install test smoke lint migrate reset login logout repl server dev fmt doctor

help:
	@echo "Targets:"
	@echo ""
	@echo "  Setup:"
	@echo "    install    uv sync --extra dev (workspace + dev deps)"
	@echo "    doctor     verify env + DB + migrations + plugins"
	@echo ""
	@echo "  Database (admin mode, env-var driven):"
	@echo "    migrate    apply Alembic migrations to head"
	@echo "    reset      drop the eidan schema and re-apply migrations"
	@echo ""
	@echo "  Run:"
	@echo "    login      eidan login (--email, see .env.example)"
	@echo "    logout     discard the stored JWT"
	@echo "    repl       open the in-process REPL against the loaded plugins"
	@echo "    server     start the FastAPI HTTP surface (eidan admin server)"
	@echo "    dev        backend + web together via turbo (one terminal, switchable panes)"
	@echo ""
	@echo "  Quality:"
	@echo "    test       run the full pytest suite"
	@echo "    smoke      Phase 1.5 end-to-end smoke (ephemeral Postgres)"
	@echo "    lint       ruff check"
	@echo "    fmt        ruff format"

install:
	uv sync --extra dev

doctor:
	uv run eidan admin doctor

migrate:
	uv run eidan admin db migrate

reset:
	uv run eidan admin db reset

login:
	uv run eidan login

logout:
	uv run eidan logout

repl:
	uv run eidan repl

server:
	uv run eidan admin server

dev:
	pnpm dev

test:
	uv run pytest

smoke:
	uv run pytest apps/backend/tests/test_phase1_smoke.py -v

lint:
	uv run ruff check .

fmt:
	uv run ruff format .
