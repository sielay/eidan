# SPDX-License-Identifier: AGPL-3.0-or-later
"""Self-serve secrets API — `docs/031` Phase 2.

The authenticated front door for per-user credentials: a user stores their
own integration secret (a Stripe key, an OAuth token) under a key a plugin
declared ``user_provided`` in its manifest. The value is Fernet-sealed at
rest, scoped to the caller (`request.state.identity`), and **never read
back** — the API is write-only for values; ``GET`` returns metadata only.

Enforcement: a write is accepted only for keys some loaded plugin declared
``user_provided`` (`secrets.user_provided_keys`), so a caller can't stash
arbitrary material in the vault. Auth is the bearer middleware (the route is
not in the unauthenticated allowlist), so every request carries an identity.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from .. import secrets as secrets_mod

logger = logging.getLogger(__name__)

router = APIRouter()


class SetSecretBody(BaseModel):
    value: str = Field(min_length=1)
    ttl_seconds: int | None = None


def _user_uuid(request: Request) -> UUID:
    ident = getattr(request.state, "identity", None)
    uid = getattr(ident, "user_id", None)
    if not uid:
        raise HTTPException(status_code=401, detail="authentication required")
    try:
        return UUID(str(uid))
    except (ValueError, TypeError):
        raise HTTPException(status_code=401, detail="invalid user identity") from None


def _require_user_provided(request: Request, key: str) -> None:
    declared = secrets_mod.user_provided_keys(
        getattr(request.app.state, "plugins", []) or []
    )
    if key not in declared:
        raise HTTPException(
            status_code=403,
            detail=f"{key!r} is not a user-provided secret key",
        )


@router.get("/api/me/secrets")
async def list_my_secrets(request: Request) -> dict[str, Any]:
    """List the caller's stored secret keys (metadata only — no values)."""
    user_id = _user_uuid(request)
    rows = await secrets_mod.list_user_secrets(
        request.app.state.pool, user_id=user_id
    )
    return {"secrets": rows}


@router.put("/api/me/secrets/{key}")
async def set_my_secret(
    key: str, body: SetSecretBody, request: Request
) -> dict[str, Any]:
    """Store (encrypted) the caller's value for a ``user_provided`` key."""
    user_id = _user_uuid(request)
    _require_user_provided(request, key)
    await secrets_mod.write(
        request.app.state.pool,
        key,
        body.value,
        user_id=user_id,
        ttl_seconds=body.ttl_seconds,
        actor="me-api",
    )
    return {"ok": True, "key": key}


@router.delete("/api/me/secrets/{key}")
async def delete_my_secret(key: str, request: Request) -> dict[str, Any]:
    """Delete the caller's own value for a key (idempotent, owner-scoped)."""
    user_id = _user_uuid(request)
    await secrets_mod.delete(
        request.app.state.pool, key, user_id=user_id, actor="me-api"
    )
    return {"ok": True, "key": key}
