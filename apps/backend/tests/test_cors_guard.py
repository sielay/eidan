"""CORS production-mode guard (audit §5 fix 2/3).

The CORS spec disallows ``Access-Control-Allow-Origin: *`` paired
with ``Access-Control-Allow-Credentials: true``. Starlette's
CORSMiddleware doesn't enforce that, so a production deployment
with ``EIDAN_HTTP_CORS_ORIGINS=*`` would either fail every browser
request or (with starlette's loose stance) open a CSRF window. The
guard in `_resolve_cors_origins` refuses the combo when
``EIDAN_DEPLOYMENT_MODE=production`` is set, with an actionable
error.

Dev installs keep the wildcard for convenience — single-operator
local runs against http://localhost:3000 + http://localhost:5173
+ whatever frontend dev port — that's a real workflow and we
shouldn't break it.
"""

from __future__ import annotations

import pytest
from eidan_backend.http.app import _resolve_cors_origins


def test_explicit_origins_pass_through() -> None:
    out = _resolve_cors_origins(
        "https://app.eidan.dev,http://localhost:3000"
    )
    assert out == ["https://app.eidan.dev", "http://localhost:3000"]


def test_empty_string_is_empty_list() -> None:
    assert _resolve_cors_origins("") == []
    assert _resolve_cors_origins("   ") == []


def test_strips_whitespace_around_commas() -> None:
    out = _resolve_cors_origins(" a , b  ,c")
    assert out == ["a", "b", "c"]


def test_wildcard_allowed_outside_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("EIDAN_DEPLOYMENT_MODE", raising=False)
    out = _resolve_cors_origins("*")
    assert out == ["*"]


def test_wildcard_allowed_when_deployment_mode_is_dev(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EIDAN_DEPLOYMENT_MODE", "dev")
    out = _resolve_cors_origins("*")
    assert out == ["*"]


def test_wildcard_refused_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EIDAN_DEPLOYMENT_MODE", "production")
    with pytest.raises(RuntimeError, match="contains '\\*'"):
        _resolve_cors_origins("*")


def test_wildcard_in_a_list_still_refused_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An operator who mistakenly mixes ``*`` with explicit origins
    in production triggers the guard — the `*` is the dangerous
    entry regardless of what else is in the list."""
    monkeypatch.setenv("EIDAN_DEPLOYMENT_MODE", "production")
    with pytest.raises(RuntimeError):
        _resolve_cors_origins("https://app.eidan.dev,*")
