"""Local credential storage.

Prefers the OS keychain via `keyring`. Falls back to `~/.eidan/auth.json`
when no usable backend is available (Linux without a Secret Service,
CI). The fallback file is created mode 0600 so a curious reader on a
shared box does not pick it up by accident.
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import asdict, dataclass
from pathlib import Path

import keyring
from keyring.errors import KeyringError

_KEYRING_SERVICE = "eidan-cli"
_KEYRING_USER = "access"


def _fallback_path() -> Path:
    return Path.home() / ".eidan" / "auth.json"


@dataclass(frozen=True, slots=True)
class StoredAuth:
    access_token: str
    refresh_token: str | None
    expires_at: int | None
    email: str | None
    provider: str


def _write_fallback(auth: StoredAuth) -> None:
    path = _fallback_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(auth)))
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def _read_fallback() -> StoredAuth | None:
    path = _fallback_path()
    if not path.exists():
        return None
    return StoredAuth(**json.loads(path.read_text()))


def save(auth: StoredAuth) -> None:
    """Persist credentials. Tries keychain; falls back to ~/.eidan/auth.json."""
    payload = json.dumps(asdict(auth))
    try:
        keyring.set_password(_KEYRING_SERVICE, _KEYRING_USER, payload)
    except KeyringError:
        _write_fallback(auth)


def load() -> StoredAuth | None:
    """Read credentials from keychain or fallback. Returns None if absent."""
    try:
        payload = keyring.get_password(_KEYRING_SERVICE, _KEYRING_USER)
    except KeyringError:
        payload = None
    if payload:
        return StoredAuth(**json.loads(payload))
    return _read_fallback()


def clear() -> None:
    """Discard stored credentials from every backend."""
    try:
        keyring.delete_password(_KEYRING_SERVICE, _KEYRING_USER)
    except KeyringError:
        pass
    fallback = _fallback_path()
    if fallback.exists():
        fallback.unlink()
