"""Backend configuration.

Reads from the process environment via pydantic-settings. Two surfaces:

- :class:`BackendSettings` — what the agent loop and persistence need
  (DB URL, provider keys, budget caps).
- :class:`HttpSettings` — bind host/port, CORS allowlist, log file.

Auth no longer has its own settings model — the native subsystem
(`docs/011 §11`) reads ``EIDAN_AUTH_MASTER_KEY`` /
``EIDAN_AUTH_ALLOWED_EMAIL`` / ``EIDAN_SMTP_*`` directly from the
environment at the point of use.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

if TYPE_CHECKING:
    from .classifiers import SizerConfig


class HttpSettings(BaseSettings):
    """HTTP server tuning. Read by the ``eidan-backend-http`` entry point."""

    model_config = SettingsConfigDict(
        env_prefix="EIDAN_HTTP_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "info"
    cors_origins: str = Field(
        "http://localhost:3000",
        description="Comma-separated list of allowed CORS origins.",
    )
    log_file: str = Field(
        "logs/backend.log",
        description=(
            "Path to write a duplicate of every log record to. Relative "
            "paths resolve from the process's CWD. Defaulted to "
            "``logs/backend.log`` so `make dev` produces grep-friendly "
            "logs the Turbo TUI can't swallow. Set to empty string to "
            "disable file logging entirely."
        ),
    )


def load_http_settings() -> HttpSettings:
    return HttpSettings()


class BackendSettings(BaseSettings):
    """Backend configuration. Loaded from the environment."""

    model_config = SettingsConfigDict(
        env_prefix="EIDAN_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # `populate_by_name=True` lets callers (tests, the CLI) construct
        # this directly with field-name kwargs (``provider="ollama"``)
        # instead of going through the env-var alias. Production reads
        # still come from the aliased env vars; the flag just unblocks
        # in-process construction.
        populate_by_name=True,
    )

    database_url: str = Field(
        ...,
        validation_alias="DATABASE_URL",
        description="Postgres URL, asyncpg-compatible (postgresql+asyncpg://...).",
    )

    # Primary provider config — Phase 1 ships Anthropic and OpenAI
    # adapters. ``provider`` picks which one the host instantiates;
    # only that adapter's API key needs to be set. ``ollama`` is a
    # shorthand that maps to the OpenAI adapter against the local
    # Ollama OpenAI-compatible endpoint — convenient for the Sentry
    # plugin's Phi-3 / Mistral local-inference path.
    provider: Literal["anthropic", "openai", "ollama"] = Field(
        "anthropic",
        validation_alias="EIDAN_PROVIDER",
    )
    anthropic_api_key: str | None = Field(
        None,
        validation_alias="ANTHROPIC_API_KEY",
    )
    openai_api_key: str | None = Field(
        None,
        validation_alias="OPENAI_API_KEY",
    )
    openai_base_url: str | None = Field(
        None,
        validation_alias="OPENAI_BASE_URL",
        description=(
            "Optional OpenAI-compatible base URL (Azure OpenAI, vLLM, "
            "or any other compatible gateway). Defaults to OpenAI's "
            "public endpoint."
        ),
    )
    ollama_base_url: str = Field(
        "http://localhost:11434/v1",
        validation_alias="OLLAMA_BASE_URL",
        description=(
            "OpenAI-compatible endpoint exposed by an Ollama daemon. "
            "Defaults to the local install's port. The OpenAI adapter "
            "drives it transparently — model names are whatever "
            "Ollama has pulled (`ollama pull phi3`, `ollama list`)."
        ),
    )
    default_model: str = Field(
        "claude-haiku-4-5-20251001",
        validation_alias="EIDAN_DEFAULT_MODEL",
        description=(
            "Model name the host passes to the provider on every "
            "call when no per-route override is set. Defaults to "
            "Haiku — the cheapest Anthropic tier — so an operator "
            "who boots without setting EIDAN_DEFAULT_MODEL doesn't "
            "get billed at Opus rates by accident. Override per "
            "node: `phi3` on Ollama, `claude-sonnet-4-6` for a "
            "stronger foreground agent on Fly, etc."
        ),
    )

    # Sizer (step ④ of the agentic loop) — per-node model vocabulary.
    # The slot map (cheap / deep / opus) is what the sizer chooses
    # between for the *primary* call; ``sizer_runtime_model`` is what
    # drives the sizer call itself. A Pi-with-ollama node points all
    # four at local ids so the loop never reaches for an Anthropic
    # endpoint it doesn't have credentials for; a cloud node leaves
    # the defaults (issue #59).
    sizer_runtime_model: str = Field(
        "claude-haiku-4-5-20251001",
        validation_alias="EIDAN_SIZER_MODEL",
        description=(
            "Model that runs the sizer call itself. Must be a model "
            "the configured provider can serve — on a Pi-with-ollama "
            "node set this to e.g. `phi3` so the sizer never reaches "
            "for an Anthropic endpoint."
        ),
    )
    sizer_cheap_model: str = Field(
        "claude-haiku-4-5-20251001",
        validation_alias="EIDAN_SIZER_CHEAP_MODEL",
        description=(
            "Model id the sizer routes ordinary turns to (the "
            "default-deny case in the prompt). Pi: `phi3`. Fly: "
            "leave as the Anthropic haiku default."
        ),
    )
    sizer_deep_model: str = Field(
        "claude-sonnet-4-6",
        validation_alias="EIDAN_SIZER_DEEP_MODEL",
        description=(
            "Model id the sizer escalates to when the criteria fire "
            "(multi-step plan, multi-entity synthesis, explicit ask "
            "for depth, high-stakes wording)."
        ),
    )
    sizer_opus_model: str = Field(
        "claude-opus-4-7",
        validation_alias="EIDAN_SIZER_OPUS_MODEL",
        description=(
            "Model id reached by the user-phrase opus override path. "
            "Point at `sizer_deep_model` to disable the override on "
            "nodes where opus isn't available."
        ),
    )

    # Budget caps (`docs/010 §2`). Per-turn is a hard stop *during* a
    # turn: the loop short-circuits before the next provider call when
    # the running `llm_calls` total for the anchor user_message_id
    # crosses the cap. Per-day is a pre-flight gate: the route refuses
    # new turns once the rolling 24h spend for the user is above the
    # ceiling.
    #
    # Zero / unset disables the corresponding cap. The per-turn default
    # is intentionally non-zero so a runaway tool loop has an upper
    # bound even on a fresh install; per-day is opt-in.
    max_turn_cost_usd: float = Field(
        1.00,
        validation_alias="EIDAN_MAX_TURN_COST_USD",
    )
    max_daily_cost_usd: float | None = Field(
        None,
        validation_alias="EIDAN_MAX_DAILY_COST_USD",
    )

    # Logging
    log_level: str = "INFO"

    def sizer_config(self) -> SizerConfig:
        """Build the sizer's per-node slot map from the env vars above.

        Imported lazily so :mod:`eidan_backend.config` stays free of
        ``classifiers`` deps at module import time.
        """
        from .classifiers import SizerConfig

        return SizerConfig(
            runtime_model=self.sizer_runtime_model,
            cheap_model=self.sizer_cheap_model,
            deep_model=self.sizer_deep_model,
            opus_model=self.sizer_opus_model,
        )


def load_backend_settings() -> BackendSettings:
    return BackendSettings()
