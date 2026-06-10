# SPDX-License-Identifier: AGPL-3.0-or-later
"""Self-serve secrets API + user_provided manifest flag (docs/031 Phase 2).

No DB / app fixture: the route handlers read ``request.app.state.pool`` /
``request.state.identity`` / ``request.app.state.plugins``, so a SimpleNamespace
request + a fake pool exercise the gating, write, list, and delete paths in
isolation.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from eidan_backend import secrets as secrets_mod
from eidan_backend.http import secrets as api
from fastapi import HTTPException


def _item(
    key: str,
    *,
    required: bool = False,
    user_provided: bool = False,
    description: str = "",
):
    return SimpleNamespace(
        key=key,
        required=required,
        user_provided=user_provided,
        description=description,
    )


def _plugin(*vault):
    return SimpleNamespace(manifest=SimpleNamespace(vault=list(vault)))


class _Conn:
    def __init__(self, fetch: list | None = None) -> None:
        self.calls: list[tuple] = []
        self._fetch = fetch or []

    async def execute(self, sql: str, *a: object) -> str:
        self.calls.append((sql, a))
        return "OK"

    async def fetch(self, sql: str, *a: object) -> list:
        self.calls.append((sql, a))
        return self._fetch


class _Acq:
    def __init__(self, c: _Conn) -> None:
        self._c = c

    async def __aenter__(self) -> _Conn:
        return self._c

    async def __aexit__(self, *a: object) -> bool:
        return False


class _Pool:
    def __init__(self, c: _Conn) -> None:
        self._c = c

    def acquire(self) -> _Acq:
        return _Acq(self._c)


@pytest.fixture
def patched_crypto(monkeypatch: pytest.MonkeyPatch) -> None:
    import eidan_backend.auth_native.vault_crypto as vc

    monkeypatch.setattr(vc, "encrypt_value", lambda b: b"C:" + b)


def _request(pool: _Pool, *, user_id, plugins: list):
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(pool=pool, plugins=plugins)),
        state=SimpleNamespace(identity=SimpleNamespace(user_id=str(user_id))),
    )


def test_user_provided_keys_collects_across_plugins() -> None:
    plugins = [
        _plugin(_item("stripe.api_key", user_provided=True), _item("x.y")),
        _plugin(_item("ga.token", user_provided=True)),
    ]
    assert secrets_mod.user_provided_keys(plugins) == {"stripe.api_key", "ga.token"}


@pytest.mark.asyncio
async def test_validate_skips_user_provided_even_if_required() -> None:
    async def secret(key: str) -> str | None:
        return None  # nothing resolves at activation

    # required + user_provided -> skipped, no raise
    await secrets_mod.validate_required_secrets(
        secret,
        plugin_name="p",
        declared=[_item("stripe.api_key", required=True, user_provided=True)],
    )
    # required + not user_provided + unresolved -> raises
    with pytest.raises(secrets_mod.MissingRequiredSecret):
        await secrets_mod.validate_required_secrets(
            secret, plugin_name="p", declared=[_item("op.key", required=True)]
        )


@pytest.mark.asyncio
async def test_set_rejects_undeclared_key(patched_crypto: None) -> None:
    req = _request(
        _Pool(_Conn()),
        user_id=uuid.uuid4(),
        plugins=[_plugin(_item("stripe.api_key", user_provided=True))],
    )
    with pytest.raises(HTTPException) as ei:
        await api.set_my_secret("not.declared", api.SetSecretBody(value="x"), req)
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_set_writes_declared_key_for_the_user(patched_crypto: None) -> None:
    conn = _Conn()
    uid = uuid.uuid4()
    req = _request(
        _Pool(conn),
        user_id=uid,
        plugins=[_plugin(_item("stripe.api_key", user_provided=True))],
    )
    res = await api.set_my_secret("stripe.api_key", api.SetSecretBody(value="sk"), req)
    assert res == {"ok": True, "key": "stripe.api_key"}
    ins_sql, ins_args = conn.calls[0]
    assert "INSERT INTO eidan.secrets_vault" in ins_sql
    assert ins_args[0] == uid and ins_args[1] == "stripe" and ins_args[2] == "api_key"


@pytest.mark.asyncio
async def test_list_returns_catalogue_metadata_only(patched_crypto: None) -> None:
    # one declared key the user HAS set, one declared key they HAVEN'T
    conn = _Conn(
        fetch=[{"scope": "stripe", "key": "api_key", "expires_at": None, "updated_at": None}]
    )
    plugins = [
        _plugin(
            _item("stripe.api_key", user_provided=True, description="Stripe key"),
            _item("ga.token", user_provided=True, description="GA token"),
        )
    ]
    req = _request(_Pool(conn), user_id=uuid.uuid4(), plugins=plugins)
    res = await api.list_my_secrets(req)
    assert res["connections"] == [
        {"key": "ga.token", "description": "GA token", "configured": False, "expires_at": None},
        {"key": "stripe.api_key", "description": "Stripe key", "configured": True, "expires_at": None},
    ]
    assert "value_enc" not in conn.calls[0][0]  # value never selected


@pytest.mark.asyncio
async def test_delete_is_owner_scoped(patched_crypto: None) -> None:
    conn = _Conn()
    uid = uuid.uuid4()
    req = _request(_Pool(conn), user_id=uid, plugins=[])
    res = await api.delete_my_secret("stripe.api_key", req)
    assert res["ok"] is True
    del_sql, del_args = conn.calls[0]
    assert "DELETE FROM eidan.secrets_vault" in del_sql and del_args[0] == uid


@pytest.mark.asyncio
async def test_missing_identity_is_401(patched_crypto: None) -> None:
    req = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(pool=_Pool(_Conn()), plugins=[])),
        state=SimpleNamespace(identity=None),
    )
    with pytest.raises(HTTPException) as ei:
        await api.list_my_secrets(req)
    assert ei.value.status_code == 401
