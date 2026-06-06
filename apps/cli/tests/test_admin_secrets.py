# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for ``eidan admin secrets`` (set / list / delete).

The DB is stubbed with an in-memory fake connection so the round-trip
runs without Postgres; the Fernet crypto runs for real against a test
``EIDAN_AUTH_MASTER_KEY`` so a ``set`` value is proven to decrypt back
to itself (the read-back gate). Per docs/012 §9.1 the value is never
accepted as a CLI argument.
"""

from __future__ import annotations

import uuid

import pytest
from eidan_cli.admin_secrets import secrets_app
from typer.testing import CliRunner

runner = CliRunner()


class _FakeConn:
    def __init__(self, store: dict[tuple[str, str], bytes]) -> None:
        self._store = store

    async def fetchrow(self, _sql: str, *args):
        scope, key, value_enc = args
        self._store[(scope, key)] = value_enc
        return {"id": uuid.uuid4(), "value_enc": value_enc}

    async def fetch(self, _sql: str, *args):
        return [
            {"scope": s, "key": k, "updated_at": "2026-06-06T00:00:00Z"}
            for (s, k) in sorted(self._store)
        ]

    async def execute(self, _sql: str, *args):
        scope, key = args
        existed = (scope, key) in self._store
        self._store.pop((scope, key), None)
        return "DELETE 1" if existed else "DELETE 0"

    async def close(self) -> None:
        return None


@pytest.fixture
def fake_db(monkeypatch):
    store: dict[tuple[str, str], bytes] = {}

    async def _connect(_url: str):
        return _FakeConn(store)

    import asyncpg

    monkeypatch.setattr(asyncpg, "connect", _connect)
    monkeypatch.setenv("DATABASE_URL", "postgresql://stub/stub")
    monkeypatch.setenv("EIDAN_AUTH_MASTER_KEY", "test-master-key-not-secret")
    return store


def _decrypts_to(value_enc: bytes, expected: bytes) -> bool:
    from eidan_backend.auth_native.vault_crypto import decrypt_value

    return decrypt_value(value_enc) == expected


def test_set_via_stdin_seals_and_reads_back(fake_db):
    result = runner.invoke(
        secrets_app, ["set", "slack.bot_token", "--stdin"], input="xoxb-123\n"
    )
    assert result.exit_code == 0, result.output
    assert "set slack.bot_token" in result.output
    assert "xoxb-123" not in result.output
    assert _decrypts_to(fake_db[("slack", "bot_token")], b"xoxb-123")


def test_set_via_prompt(fake_db):
    # No --stdin/--from-file → hidden interactive prompt reads stdin.
    result = runner.invoke(secrets_app, ["set", "slack.bot_token"], input="xoxb-p\n")
    assert result.exit_code == 0, result.output
    assert _decrypts_to(fake_db[("slack", "bot_token")], b"xoxb-p")


def test_set_via_file(fake_db, tmp_path):
    f = tmp_path / "tok"
    f.write_text("xoxb-file\n", encoding="utf-8")
    result = runner.invoke(
        secrets_app, ["set", "slack.bot_token", "--from-file", str(f)]
    )
    assert result.exit_code == 0, result.output
    assert _decrypts_to(fake_db[("slack", "bot_token")], b"xoxb-file")


def test_set_no_dot_lands_in_core(fake_db):
    result = runner.invoke(secrets_app, ["set", "lonelykey", "--stdin"], input="v\n")
    assert result.exit_code == 0, result.output
    assert ("core", "lonelykey") in fake_db


def test_value_as_argv_is_rejected(fake_db):
    # docs/012 §9.1: the value must never be a CLI argument.
    result = runner.invoke(secrets_app, ["set", "slack.bot_token", "xoxb-leak"])
    assert result.exit_code != 0
    assert ("slack", "bot_token") not in fake_db


def test_stdin_and_file_are_mutually_exclusive(fake_db, tmp_path):
    f = tmp_path / "tok"
    f.write_text("x\n", encoding="utf-8")
    result = runner.invoke(
        secrets_app,
        ["set", "slack.bot_token", "--stdin", "--from-file", str(f)],
        input="y\n",
    )
    assert result.exit_code == 2
    assert "at most one" in result.output


def test_empty_value_rejected(fake_db):
    result = runner.invoke(secrets_app, ["set", "slack.bot_token", "--stdin"], input="")
    assert result.exit_code == 2
    assert "empty" in result.output


def test_list_shows_keys_not_values(fake_db):
    runner.invoke(secrets_app, ["set", "slack.bot_token", "--stdin"], input="xoxb-123\n")
    result = runner.invoke(secrets_app, ["list"])
    assert result.exit_code == 0, result.output
    assert "slack.bot_token" in result.output
    assert "xoxb-123" not in result.output


def test_delete_removes_and_reports_missing(fake_db):
    runner.invoke(secrets_app, ["set", "slack.bot_token", "--stdin"], input="xoxb-123\n")
    ok = runner.invoke(secrets_app, ["delete", "slack.bot_token"])
    assert ok.exit_code == 0, ok.output
    assert ("slack", "bot_token") not in fake_db

    missing = runner.invoke(secrets_app, ["delete", "slack.bot_token"])
    assert missing.exit_code == 1
    assert "no secret found" in missing.output


def test_set_without_master_key_fails(monkeypatch):
    async def _connect(_url: str):  # pragma: no cover - must not be reached
        raise AssertionError("must not connect without master key")

    import asyncpg

    monkeypatch.setattr(asyncpg, "connect", _connect)
    monkeypatch.setenv("DATABASE_URL", "postgresql://stub/stub")
    monkeypatch.delenv("EIDAN_AUTH_MASTER_KEY", raising=False)

    result = runner.invoke(
        secrets_app, ["set", "slack.bot_token", "--stdin"], input="xoxb-123\n"
    )
    assert result.exit_code == 2
    assert "EIDAN_AUTH_MASTER_KEY" in result.output
