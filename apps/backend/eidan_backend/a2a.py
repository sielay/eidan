# SPDX-License-Identifier: AGPL-3.0-or-later
"""A2A outbound client — delegate to remote A2A agents.

Mirrors the outbound MCP client (`docs/013 §4`) but for whole agents
instead of tools. An A2A client fetches a remote Agent Card
(GET {base}/.well-known/agent-card.json), sends tasks via the A2A
protocol (message/send for one-shot, message/stream for streaming),
and surfaces results/artifacts back into the calling turn.

Failures are normalised into the loop's tool-error envelope, same
posture as wrapped MCP tools. Configuration (registered remote A2A
endpoints + auth) comes from operator vault (ctx.vault), never
tracked files.

Usage example (via environment variables):

    EIDAN_A2A_AGENTS=reviewer,architect
    EIDAN_A2A_REVIEWER_BASE_URL=http://remote-instance:8000
    EIDAN_A2A_REVIEWER_AUTH_TOKEN=<bearer-token>
    EIDAN_A2A_ARCHITECT_BASE_URL=http://another-instance:8000
    EIDAN_A2A_ARCHITECT_AUTH_TOKEN=<different-token>

The bootstrap loader (`_register_a2a_tools_from_env`) reads these
at startup and registers delegation tools:
- ``delegate_to_reviewer``
- ``delegate_to_architect``

The primary agent can then invoke these tools with a ``prompt`` argument,
delegating the work to the remote agent and folding the result back
into the conversation.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import httpx

from .tools import Tool, ToolError, ToolRegistry

# ---------------------------------------------------------------------------
# Agent Card discovery and validation.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AgentCard:
    """Fetched from GET {base}/.well-known/agent-card.json.

    Describes a remote A2A agent's capabilities and interface.
    """

    id: str
    name: str
    description: str
    base_url: str


async def fetch_agent_card(base_url: str, timeout: float = 10.0) -> AgentCard:  # noqa: ASYNC109 — forwarded to httpx.AsyncClient(timeout=...)
    """Fetch and validate a remote agent's card.

    Raises httpx.RequestError / httpx.TimeoutException on network
    issues; ValueError if the card is malformed.
    """
    card_url = f"{base_url.rstrip('/')}/.well-known/agent-card.json"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.get(card_url)
        resp.raise_for_status()
        data = resp.json()

    # Minimal validation — the card must have these fields.
    required = {"id", "name", "description"}
    if not required.issubset(data.keys()):
        raise ValueError(
            f"agent card missing required fields: {required - set(data.keys())}"
        )

    return AgentCard(
        id=data["id"],
        name=data["name"],
        description=data["description"],
        base_url=base_url,
    )


# ---------------------------------------------------------------------------
# Outbound client wrapper (mirrors mcp.OutboundClient).
# ---------------------------------------------------------------------------


# The handler shape upstream A2A agents satisfy when wrapped — the host's
# ToolRegistry expects an async callable taking a dict and returning a
# string. The outbound wrapper translates each upstream call into the
# A2A protocol shape.
A2ACaller = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass(frozen=True, slots=True)
class A2AClient:
    """Skeleton for outbound A2A delegation.

    ``agent_name`` is the remote agent's id/identifier. ``card`` holds
    the fetched agent metadata. ``call`` is the HTTP transport — injected
    by the operator or a stub in tests. ``tool_name_prefix`` is an
    optional namespace (usually the remote agent's id) prepended to every
    tool registered into the host's registry.
    """

    agent_name: str
    card: AgentCard | None = None
    call: A2ACaller | None = None
    tool_name_prefix: str | None = None


@dataclass(frozen=True, slots=True)
class A2ATool:
    """A delegation tool exposing a remote A2A agent as a host-side tool.

    Maps onto a Tool the host registry can execute — carries the tool name,
    description, and input schema from the remote agent's declaration.
    """

    name: str
    description: str
    input_schema: dict


def register_a2a_tools(
    registry: ToolRegistry,
    *,
    client: A2AClient,
    agent_name: str,
) -> list[str]:
    """Register one or more delegation tools into the host registry.

    For now, registers a single `delegate_to_{agent_name}` tool that
    hands the input task to the remote agent and returns the result.
    Future versions may expose more granular control (e.g. delegation
    with custom constraints).

    Returns the list of registered tool names. Fails fast with ValueError
    if the client has no callable (stub mode).
    """
    if client.call is None:
        raise ValueError(
            f"A2A client for {agent_name} has no callable — cannot register tools"
        )

    # One tool per remote agent: "delegate_to_<name>". The agent name is
    # sanitised to a valid tool identifier (e.g. "remote-sage" ->
    # "delegate_to_remote_sage") so a hyphen/dot in the agent name can't
    # produce an invalid or surprising tool name.
    safe_name = "".join(c if (c.isalnum() or c == "_") else "_" for c in agent_name)
    tool_name = f"delegate_to_{safe_name}"
    description = (
        f"Delegate a task to the remote agent '{agent_name}'. "
        f"Input: a dict with 'prompt' (str) describing the work. "
        f"Returns: the agent's response as a string, or raises ToolError on failure."
    )

    input_schema = {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "The task/prompt to delegate to the remote agent.",
                "minLength": 1,
            },
        },
        "required": ["prompt"],
        "additionalProperties": False,
    }

    async def handler(
        args: dict[str, Any],
        _agent_name: str = agent_name,
        _call: A2ACaller = client.call,
    ) -> str:
        prompt = args.get("prompt", "")
        if not prompt:
            raise ToolError("prompt is required and must be non-empty")

        # Call the remote agent via the A2A protocol.
        # Format: message/send request with the prompt.
        try:
            envelope = await _call("message/send", {"prompt": prompt})
        except Exception as exc:
            raise ToolError(f"A2A call to {_agent_name} failed: {exc}") from exc

        # Check for errors in the response.
        if envelope.get("isError"):
            texts = [
                block.get("text", "")
                for block in envelope.get("content", [])
                if isinstance(block, dict)
            ]
            error_msg = "; ".join(t for t in texts if t)
            raise ToolError(
                f"remote A2A agent {_agent_name!r} returned error: {error_msg}"
            )

        # Extract text content from the response.
        blocks = envelope.get("content", [])
        result = "\n".join(
            block.get("text", "")
            for block in blocks
            if isinstance(block, dict) and block.get("type") == "text"
        )
        return result or "(empty response from remote agent)"

    registry.register(
        Tool(
            name=tool_name,
            description=description,
            input_schema=input_schema,
            handler=handler,
        )
    )

    return [tool_name]


# ---------------------------------------------------------------------------
# HTTP transport for A2A calls (the "call" callable).
# ---------------------------------------------------------------------------


async def a2a_http_call(
    base_url: str,
    method: str,
    args: dict[str, Any],
    *,
    auth_token: str | None = None,
    timeout: float = 30.0,  # noqa: ASYNC109 — forwarded to httpx.AsyncClient(timeout=...)
) -> dict[str, Any]:
    """Execute an A2A method call via HTTP JSON-RPC.

    ``method`` is a string like "message/send" or "message/stream".
    ``args`` are the request parameters. ``auth_token`` is an optional
    bearer token (from vault). Returns the parsed JSON response envelope.

    Raises httpx.RequestError / httpx.TimeoutException on network issues;
    other exceptions are surfaced as-is for the handler to catch.
    """
    url = f"{base_url.rstrip('/')}/rpc"

    headers = {}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"

    payload = {
        "jsonrpc": "2.0",
        "method": method,
        "params": args,
        "id": str(uuid4()),
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()

    # Check for JSON-RPC error in the response.
    if "error" in data:
        error_detail = data["error"].get("message", "unknown error")
        return {
            "isError": True,
            "content": [{"type": "text", "text": error_detail}],
        }

    # Extract result. Expect {"result": {...content...}} shape.
    result = data.get("result", {})
    return result or {
        "content": [{"type": "text", "text": ""}],
    }


__all__ = [
    "A2ACaller",
    "A2AClient",
    "A2ATool",
    "AgentCard",
    "a2a_http_call",
    "fetch_agent_card",
    "register_a2a_tools",
]
