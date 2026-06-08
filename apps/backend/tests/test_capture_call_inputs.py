# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for :func:`eidan_backend.persistence.capture_call_inputs`.

The helper is what each classifier / primary / critic call site uses
to stash the system prompt + user-text excerpt into the
``ProviderCallResult.metadata`` blob before persistence. The
introspection panel (#152) reads that blob back via
``GET /api/conversations/{id}/llm_calls`` to render "what did the
model actually see" alongside the existing telemetry.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from eidan_backend.persistence import USER_TEXT_EXCERPT_LIMIT, capture_call_inputs
from eidan_backend.providers.base import (
    AssistantMessage,
    ProviderCallResult,
)


def _bare_call() -> ProviderCallResult:
    now = datetime.now(tz=UTC)
    return ProviderCallResult(
        message=AssistantMessage(
            content="ok", provider="fake", model="fake-1"
        ),
        input_tokens=10,
        output_tokens=2,
        started_at=now,
        finished_at=now,
    )


def test_captures_system_prompt_and_user_text() -> None:
    call = _bare_call()
    out = capture_call_inputs(
        call,
        system_prompt="be brief",
        user_text="hello world",
    )
    assert out.metadata["system_prompt"] == "be brief"
    assert out.metadata["user_text_excerpt"] == "hello world"


def test_truncates_user_text_excerpt_to_limit() -> None:
    """Long user input doesn't bloat every per-call row — the
    excerpt is clipped to ``USER_TEXT_EXCERPT_LIMIT`` chars."""
    call = _bare_call()
    long_text = "x" * (USER_TEXT_EXCERPT_LIMIT + 500)
    out = capture_call_inputs(
        call, system_prompt="sys", user_text=long_text
    )
    assert len(out.metadata["user_text_excerpt"]) == USER_TEXT_EXCERPT_LIMIT


def test_preserves_existing_metadata_keys() -> None:
    """Provider adapters sometimes prepopulate metadata (request
    headers, model-side trace ids). The helper merges into that
    dict rather than replacing it."""
    now = datetime.now(tz=UTC)
    call = ProviderCallResult(
        message=AssistantMessage(content="ok", provider="fake", model="fake-1"),
        input_tokens=10,
        output_tokens=2,
        started_at=now,
        finished_at=now,
        metadata={"provider_trace_id": "abc-123"},
    )
    out = capture_call_inputs(
        call, system_prompt="sys", user_text="hi"
    )
    assert out.metadata["provider_trace_id"] == "abc-123"
    assert out.metadata["system_prompt"] == "sys"


def test_user_text_optional() -> None:
    """A call site with no inbound user text (e.g. a continuation
    iteration that sees only tool results) just records the system
    prompt — the excerpt key is omitted rather than written as an
    empty string, so the UI can distinguish 'no input here' from
    'input was empty'."""
    call = _bare_call()
    out = capture_call_inputs(call, system_prompt="sys")
    assert out.metadata["system_prompt"] == "sys"
    assert "user_text_excerpt" not in out.metadata


def test_extra_metadata_merged() -> None:
    """Extra-metadata kwarg lets a call site stash bonus context
    (e.g. retry kind, iteration index) alongside the standard
    keys."""
    call = _bare_call()
    out = capture_call_inputs(
        call,
        system_prompt="sys",
        user_text="hi",
        extra={"iteration": 3, "retry_kind": "tightened_addendum"},
    )
    assert out.metadata["iteration"] == 3
    assert out.metadata["retry_kind"] == "tightened_addendum"


def test_original_call_is_unchanged() -> None:
    """``ProviderCallResult`` is frozen; the helper returns a fresh
    copy and never mutates the caller's instance."""
    call = _bare_call()
    out = capture_call_inputs(call, system_prompt="sys", user_text="hi")
    assert call.metadata == {}
    assert out is not call


def test_repeated_calls_idempotent_on_same_inputs() -> None:
    """Pumping the same payload through twice yields equal
    metadata — useful when an upstream wrapper might double-wrap."""
    call = _bare_call()
    first = capture_call_inputs(call, system_prompt="sys", user_text="hi")
    second = capture_call_inputs(first, system_prompt="sys", user_text="hi")
    assert first.metadata == second.metadata


def test_helper_is_re_exported_from_persistence() -> None:
    """Public surface check: classifiers / loop import this from
    persistence; if a rename leaks across PRs the import here
    surfaces the breakage."""
    import eidan_backend.persistence as persistence

    assert callable(persistence.capture_call_inputs)
    assert isinstance(persistence.USER_TEXT_EXCERPT_LIMIT, int)


@pytest.mark.parametrize("limit", [USER_TEXT_EXCERPT_LIMIT])
def test_limit_is_a_positive_integer(limit: int) -> None:
    """The clip limit must stay positive — a 0 would record an
    always-empty excerpt and silently break the panel."""
    assert limit > 0


def test_stashes_node_identity_from_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When ``EIDAN_NODE_ID`` / ``EIDAN_NODE_TYPE`` are set, the
    capture helper stashes them in metadata so the introspection
    panel can render a chip for which node executed the turn (#169)."""
    monkeypatch.setenv("EIDAN_NODE_ID", "raspberry")
    monkeypatch.setenv("EIDAN_NODE_TYPE", "pi")
    out = capture_call_inputs(
        _bare_call(),
        system_prompt="sys",
        user_text="hi",
    )
    assert out.metadata["node_id"] == "raspberry"
    assert out.metadata["node_type"] == "pi"


def test_omits_node_identity_when_env_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No env → no keys in the blob (rather than a placeholder
    string). The UI renders no chip in that case, which is the
    right signal for a test boot / degraded start where the
    operator hasn't pinned an id yet."""
    monkeypatch.delenv("EIDAN_NODE_ID", raising=False)
    monkeypatch.delenv("EIDAN_NODE_TYPE", raising=False)
    out = capture_call_inputs(
        _bare_call(),
        system_prompt="sys",
        user_text="hi",
    )
    assert "node_id" not in out.metadata
    assert "node_type" not in out.metadata


def test_extra_metadata_wins_over_node_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A call site that knows better — e.g. a subagent invocation
    that wants to record the *parent* node id rather than the
    current process's — can override via ``extra``. The order in
    :func:`capture_call_inputs` applies ``extra`` last."""
    monkeypatch.setenv("EIDAN_NODE_ID", "current-node")
    out = capture_call_inputs(
        _bare_call(),
        system_prompt="sys",
        user_text="hi",
        extra={"node_id": "parent-node"},
    )
    assert out.metadata["node_id"] == "parent-node"
