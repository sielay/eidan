# SPDX-License-Identifier: AGPL-3.0-or-later
"""secrets per-user write/delete/read + accessor scoping (docs/031 Phase 1).

No DB and no master key: a fake pool records SQL, and the Fernet
encrypt/decrypt are patched, so this tests the SQL shape, the per-user
addressing, the audit row, and the accessor's user resolution in isolation.
"""

from __future__ import annotations

import uuid

import pytest
from eidan_backend import secrets as secrets_mod


class _Conn:
    def __init__(self, fetchrow: dict | None = None) -> None:
        self.calls: list[tuple[str, tuple]] = []
        self._fetchrow = fetchrow

    async def execute(self, sql: str, *args: object) -> str:
        self.calls.append((sql, args))
        return "OK"

    async def fetchrow(self, sql: str, *args: object) -> dict | None:
        self.calls.append((sql, args))
        return self._fetchrow


class _Acquire:
    def __init__(self, conn: _Conn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _Conn:
        return self._conn

    async def __aexit__(self, *a: object) -> bool:
        return False


class _Pool:
    def __init__(self, conn: _Conn) -> None:
        self._conn = conn

    def acquire(self) -> _Acquire:
        return _Acquire(self._conn)


@pytest.fixture
def patched_crypto(monkeypatch: pytest.MonkeyPatch) -> None:
    import eidan_backend.auth_native.vault_crypto as vc

    monkeypatch.setattr(vc, "encrypt_value", lambda b: b"CIPHER:" + b)
    monkeypatch.setattr(vc, "decrypt_value", lambda b: bytes(b).replace(b"CIPHER:", b""))


@pytest.mark.asyncio
async def test_write_upserts_per_user_and_audits(patched_crypto: None) -> None:
    conn = _Conn()
    uid = uuid.uuid4()
    await secrets_mod.write(_Pool(conn), "stripe.api_key", "sk_test", user_id=uid, actor="api")
    assert len(conn.calls) == 2  # upsert + audit
    ins_sql, ins_args = conn.calls[0]
    assert "INSERT INTO eidan.secrets_vault" in ins_sql
    assert "ON CONFLICT (user_id, scope, key)" in ins_sql
    assert ins_args[0] == uid and ins_args[1] == "stripe" and ins_args[2] == "api_key"
    assert ins_args[3] == b"CIPHER:sk_test"
    assert ins_args[4] is None  # ttl_seconds
    aud_sql, aud_args = conn.calls[1]
    assert "eidan.secrets_audit" in aud_sql
    assert aud_args[0] == uid and aud_args[3] == "write" and aud_args[4] == "api"


@pytest.mark.asyncio
async def test_write_passes_ttl(patched_crypto: None) -> None:
    conn = _Conn()
    await secrets_mod.write(_Pool(conn), "k", "v", ttl_seconds=60)
    assert conn.calls[0][1][4] == 60
    assert "make_interval(secs => $5)" in conn.calls[0][0]


@pytest.mark.asyncio
async def test_delete_addresses_user_and_audits(patched_crypto: None) -> None:
    conn = _Conn()
    uid = uuid.uuid4()
    await secrets_mod.delete(_Pool(conn), "core.foo", user_id=uid, actor="ctx")
    del_sql, del_args = conn.calls[0]
    assert "DELETE FROM eidan.secrets_vault" in del_sql
    assert "user_id IS NOT DISTINCT FROM $1" in del_sql
    assert del_args[0] == uid and del_args[1] == "core" and del_args[2] == "foo"
    assert conn.calls[1][1][3] == "delete"


@pytest.mark.asyncio
async def test_read_decrypts_and_filters_ttl(patched_crypto: None) -> None:
    conn = _Conn(fetchrow={"value_enc": b"CIPHER:hello"})
    val = await secrets_mod.read(_Pool(conn), "core.foo")
    assert val == "hello"
    assert "expires_at IS NULL OR expires_at > now()" in conn.calls[0][0]


@pytest.mark.asyncio
async def test_read_missing_returns_none(patched_crypto: None) -> None:
    assert await secrets_mod.read(_Pool(_Conn(fetchrow=None)), "core.foo") is None


@pytest.mark.asyncio
async def test_accessor_write_scopes_to_current_user(
    patched_crypto: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    conn = _Conn()
    uid = uuid.uuid4()

    class _Ident:
        user_id = str(uid)

    monkeypatch.setattr("eidan_backend.identity.get_current_identity", lambda: _Ident())
    acc = secrets_mod.make_secret_accessor(_Pool(conn))  # type: ignore[arg-type]
    await acc.write("zoho.token", "t")
    assert conn.calls[0][1][0] == uid  # user_id resolved from the turn's identity


@pytest.mark.asyncio
async def test_accessor_delete_instance_scoped_without_identity(
    patched_crypto: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    conn = _Conn()
    monkeypatch.setattr("eidan_backend.identity.get_current_identity", lambda: None)
    acc = secrets_mod.make_secret_accessor(_Pool(conn))  # type: ignore[arg-type]
    await acc.delete("zoho.token")
    assert conn.calls[0][1][0] is None  # instance scope when no user in context


@pytest.mark.asyncio
async def test_read_emits_audit_row(patched_crypto: None) -> None:
    conn = _Conn(fetchrow={"value_enc": b"CIPHER:v"})
    assert await secrets_mod.read(_Pool(conn), "core.foo") == "v"
    audits = [c for c in conn.calls if "eidan.secrets_audit" in c[0]]
    assert audits and audits[0][1][3] == "read"


@pytest.mark.asyncio
async def test_read_db_error_returns_none(patched_crypto: None) -> None:
    class _Boom(_Conn):
        async def fetchrow(self, sql: str, *args: object) -> dict | None:
            raise RuntimeError("db down")

    assert await secrets_mod.read(_Pool(_Boom()), "core.foo") is None


@pytest.mark.asyncio
async def test_audit_failure_does_not_raise(patched_crypto: None) -> None:
    class _AuditFails(_Conn):
        async def execute(self, sql: str, *args: object) -> str:
            if "eidan.secrets_audit" in sql:
                raise RuntimeError("audit table gone")
            return await super().execute(sql, *args)

    conn = _AuditFails()
    # write must still succeed even though the audit insert raises
    await secrets_mod.write(_Pool(conn), "core.foo", "v", actor="t")
    assert any("INSERT INTO eidan.secrets_vault" in c[0] for c in conn.calls)
