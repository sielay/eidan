"""Interactive REPL — the Phase-1 development surface for the agent loop.

Two transports share the same prompt loop:

- **In-process** (default). The REPL imports the backend, validates the
  JWT locally, opens a Postgres pool, and drives ``run_turn`` directly.
  No HTTP server needed; fast iteration on the loop.
- **HTTP** — when ``EIDAN_BACKEND_URL`` is set, the REPL POSTs to
  ``${EIDAN_BACKEND_URL}/api/turn`` with the stored JWT and renders the
  ``text/event-stream`` response. This is what production-shaped use
  looks like; we keep the in-process path for dev convenience.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from eidan_backend.auth_native import (
    InvalidToken,
    ensure_keypair,
    master_key_configured,
    verify_access_token,
)
from eidan_backend.bootstrap import BootstrapNotMigratedError, bootstrap, shutdown
from eidan_backend.config import load_backend_settings
from eidan_backend.db import acquire, create_pool
from eidan_backend.identity import Identity
from eidan_backend.loop import TurnComplete, TurnContext, run_turn
from eidan_backend.persistence import create_conversation, upsert_user
from eidan_backend.providers import AnthropicProvider
from rich.console import Console

from .storage import load as load_auth

# Plugins live one level above apps/. The REPL is shipped from
# apps/cli/eidan_cli, so going four parents up lands at the repo root.
_PLUGINS_DIR = Path(__file__).resolve().parents[3] / "plugins"


def _resolve_user_tz() -> str:
    """Detect the operator's IANA time zone for stamping outbound turns.

    Order: ``EIDAN_DEFAULT_TZ`` env var (operator override), then
    ``tzlocal.get_localzone_name()``, then ``UTC`` as the last-resort
    fallback. Per issue #51 the surface is responsible for sending an
    honest TZ so the loop never has to guess.
    """
    override = os.environ.get("EIDAN_DEFAULT_TZ")
    if override:
        return override
    try:
        from tzlocal import get_localzone_name

        return get_localzone_name() or "UTC"
    except Exception:  # noqa: BLE001 — refuse to crash on a missing tzdata
        return "UTC"

_console = Console()


async def _last_call_stats(provider: Any) -> str:
    try:
        result = await provider.last_call_result()
    except Exception:
        return ""
    latency_ms = int(
        (result.finished_at - result.started_at).total_seconds() * 1000
    )
    return (
        f"[dim](in {result.input_tokens}t / out {result.output_tokens}t / "
        f"${result.cost_usd:.6f} / {latency_ms}ms)[/dim]"
    )


async def _run_in_process() -> int:
    auth = load_auth()
    if not auth:
        _console.print(
            "[red]not signed in.[/red] Run [cyan]eidan login[/cyan] first."
        )
        return 1

    backend = load_backend_settings()
    if not backend.anthropic_api_key:
        _console.print(
            "[red]ANTHROPIC_API_KEY is not set.[/red] "
            "Phase 1 only ships the Anthropic adapter."
        )
        return 1

    if not master_key_configured():
        _console.print(
            "[red]EIDAN_AUTH_MASTER_KEY is not set.[/red] "
            "Generate one with `python -c 'import secrets; "
            "print(secrets.token_urlsafe(48))'` and add it to .env."
        )
        return 1

    pool = await create_pool(backend.database_url)

    # Load the host's RS256 public PEM directly from Postgres and
    # verify the stored access token against it. Equivalent to what
    # the HTTP middleware does on every request; we just skip the
    # network hop because this process owns the pool.
    try:
        async with pool.acquire() as conn:
            _, public_pem = await ensure_keypair(conn)
    except Exception as exc:  # noqa: BLE001
        _console.print(f"[red]Failed to load auth keypair:[/red] {exc}")
        await pool.close()
        return 1

    try:
        native = verify_access_token(auth.access_token, public_pem=public_pem)
    except InvalidToken as exc:
        _console.print(f"[red]auth: invalid token[/red] {exc}")
        _console.print(
            "Run [cyan]eidan login[/cyan] again to mint a fresh access JWT."
        )
        await pool.close()
        return 1

    identity = Identity(
        user_id=native.user_id,
        email=native.email,
        session_id=native.session_id,
        aal="aal1",
        raw_claims={
            "sub": native.user_id,
            "email": native.email,
            "sid": native.session_id,
            "iat": int(native.issued_at.timestamp()),
            "exp": int(native.expires_at.timestamp()),
        },
    )
    provider = AnthropicProvider(api_key=backend.anthropic_api_key)
    try:
        boot = await bootstrap(
            pool=pool,
            plugins_dir=_PLUGINS_DIR,
            provider=provider,
            default_model=backend.default_model,
        )
    except BootstrapNotMigratedError as exc:
        _console.print(f"[red]{exc}[/red]")
        await pool.close()
        return 1
    tool_count = len(boot.tool_registry.surface() or [])
    if tool_count:
        _console.print(
            f"[dim]loaded {len(boot.plugins)} plugin(s); "
            f"{tool_count} tool(s) registered[/dim]"
        )

    try:
        async with acquire(pool, identity) as conn:
            await upsert_user(
                conn,
                user_id=UUID(identity.user_id),
                email=identity.email,
            )
            conversation_id = await create_conversation(
                conn,
                user_id=UUID(identity.user_id),
                title="REPL session",
            )

        ctx = TurnContext(
            identity=identity,
            conversation_id=conversation_id,
        )

        _console.print(
            f"[green]signed in[/green] as {identity.email or identity.user_id}. "
            f"Conversation [cyan]{conversation_id}[/cyan]. "
            "Type your message; Ctrl+C, Ctrl+D, or /exit to leave."
        )

        while True:
            try:
                user_text = await asyncio.get_running_loop().run_in_executor(
                    None, _read_input, "you ▸ "
                )
            except (EOFError, KeyboardInterrupt):
                _console.print()
                break

            if not user_text.strip():
                continue
            if user_text.strip() == "/exit":
                break

            _console.print("[bold]eidan ▸[/bold] ", end="")
            async for event in run_turn(
                pool=pool,
                provider=provider,
                model=backend.default_model,
                ctx=ctx,
                user_text=user_text,
                sent_at_utc=datetime.now(tz=UTC),
                user_tz=_resolve_user_tz(),
                tool_registry=boot.tool_registry,
            ):
                if isinstance(event, TurnComplete):
                    stats = await _last_call_stats(provider)
                    if stats:
                        _console.print()
                        _console.print(stats)
                    else:
                        _console.print()
                else:
                    _console.print(event.text, end="", soft_wrap=True)
                    sys.stdout.flush()
    finally:
        try:
            await shutdown(pool=pool, bootstrap_result=boot)
        except Exception:  # noqa: BLE001 — never block pool close
            pass
        await pool.close()

    return 0


# -----------------------------------------------------------------------------
# HTTP transport
# -----------------------------------------------------------------------------


def _parse_sse(buffer: str) -> tuple[list[tuple[str, str]], str]:
    """Split a buffer into completed SSE frames + the trailing partial.

    Frames end on a blank line (``\\n\\n``). Each frame's name comes from
    its ``event:`` field and its payload from concatenated ``data:``
    lines. Anything else is ignored — the SSE spec also allows ``id:``
    and ``retry:`` but the host does not emit them.
    """
    frames: list[tuple[str, str]] = []
    while "\n\n" in buffer:
        raw, buffer = buffer.split("\n\n", 1)
        event = "message"
        data_lines: list[str] = []
        for line in raw.split("\n"):
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:") :].lstrip())
        frames.append((event, "\n".join(data_lines)))
    return frames, buffer


async def _run_http(backend_url: str) -> int:
    auth = load_auth()
    if not auth:
        _console.print(
            "[red]not signed in.[/red] Run [cyan]eidan login[/cyan] first."
        )
        return 1

    base = backend_url.rstrip("/")
    headers = {"Authorization": f"Bearer {auth.access_token}"}

    async with httpx.AsyncClient(timeout=None, headers=headers) as client:
        # Create a new conversation up front; matches the in-process path.
        resp = await client.post(
            f"{base}/api/conversations",
            json={"title": "REPL session"},
        )
        if resp.status_code == 401:
            _console.print(
                "[red]auth: token rejected by backend.[/red] "
                "Run [cyan]eidan login[/cyan] again."
            )
            return 1
        resp.raise_for_status()
        conversation_id = resp.json()["id"]

        _console.print(
            f"[green]connected[/green] to [cyan]{base}[/cyan]. "
            f"Conversation [cyan]{conversation_id}[/cyan]. "
            "Type your message; Ctrl+C, Ctrl+D, or /exit to leave."
        )

        while True:
            try:
                user_text = await asyncio.get_running_loop().run_in_executor(
                    None, _read_input, "you ▸ "
                )
            except (EOFError, KeyboardInterrupt):
                _console.print()
                break

            if not user_text.strip():
                continue
            if user_text.strip() == "/exit":
                break

            _console.print("[bold]eidan ▸[/bold] ", end="")
            sys.stdout.flush()

            buffer = ""
            async with client.stream(
                "POST",
                f"{base}/api/turn",
                json={
                    "conversation_id": conversation_id,
                    "text": user_text,
                    "sent_at_utc": datetime.now(tz=UTC).isoformat(),
                    "user_tz": _resolve_user_tz(),
                },
            ) as stream:
                if stream.status_code >= 400:
                    body = await stream.aread()
                    _console.print()
                    _console.print(
                        f"[red]/api/turn failed[/red] "
                        f"({stream.status_code}): {body.decode('utf-8', 'replace')}"
                    )
                    continue
                async for chunk in stream.aiter_text():
                    buffer += chunk
                    frames, buffer = _parse_sse(buffer)
                    for event, data in frames:
                        if event == "chunk":
                            try:
                                payload = json.loads(data)
                            except json.JSONDecodeError:
                                continue
                            _console.print(
                                payload.get("text", ""),
                                end="",
                                soft_wrap=True,
                            )
                            sys.stdout.flush()
                        elif event == "complete":
                            _console.print()
            # End of stream; loop for next prompt.

    return 0


async def _run() -> int:
    backend_url = os.environ.get("EIDAN_BACKEND_URL")
    if backend_url:
        return await _run_http(backend_url)
    return await _run_in_process()


def _read_input(prompt: str) -> str:
    try:
        return input(prompt)
    except EOFError:
        raise


def main() -> int:
    try:
        return asyncio.run(_run())
    except KeyboardInterrupt:
        # Belt-and-braces: the prompt loop catches Ctrl+C while we're
        # at the prompt, but the streaming response window (or any
        # other await point) can still raise here. Treat it as a
        # clean exit so the user never sees a traceback.
        _console.print()
        return 0
