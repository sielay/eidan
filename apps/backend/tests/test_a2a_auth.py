# SPDX-License-Identifier: AGPL-3.0-or-later
"""Tests for A2A authentication & security schemes."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest
from eidan_backend.a2a_vault import A2ACredential, A2AVaultManager
from eidan_backend.auth_native import InvalidToken
from eidan_backend.auth_native.api_keys import (
    APIKeyExpired,
    APIKeyNotFound,
    validate_api_key,
)
from eidan_backend.http.a2a_auth import (
    A2AAuthError,
    a2a_jsonrpc_error_response,
    authenticate_a2a_request,
)

# ============================================================================
# API Key Validation Tests
# ============================================================================


@pytest.mark.asyncio
async def test_validate_api_key_success():
    """Valid API key returns user_id and optional scope."""
    user_id = str(uuid4())
    secret_accessor = AsyncMock(
        return_value=json.dumps({
            "user_id": user_id,
            "scope": "admin",
            "created_at": "2026-01-01T00:00:00+00:00",
        })
    )

    result_user_id, result_scope = await validate_api_key(
        "valid-key",
        scope="test",
        secret_accessor=secret_accessor,
    )

    assert result_user_id == user_id
    assert result_scope == "admin"
    secret_accessor.assert_called_once()


@pytest.mark.asyncio
async def test_validate_api_key_missing():
    """Missing API key raises APIKeyNotFound."""
    secret_accessor = AsyncMock(return_value=None)

    with pytest.raises(APIKeyNotFound):
        await validate_api_key(
            "missing-key",
            scope="test",
            secret_accessor=secret_accessor,
        )


@pytest.mark.asyncio
async def test_validate_api_key_expired():
    """Expired API key raises APIKeyExpired."""
    past = (datetime.now(tz=UTC) - timedelta(hours=1)).isoformat()
    secret_accessor = AsyncMock(
        return_value=json.dumps({
            "user_id": str(uuid4()),
            "scope": None,
            "expires_at": past,
        })
    )

    with pytest.raises(APIKeyExpired):
        await validate_api_key(
            "expired-key",
            scope="test",
            secret_accessor=secret_accessor,
        )


@pytest.mark.asyncio
async def test_validate_api_key_malformed_metadata():
    """Malformed vault metadata raises APIKeyNotFound."""
    secret_accessor = AsyncMock(return_value="not-valid-json{")

    with pytest.raises(APIKeyNotFound):
        await validate_api_key(
            "bad-key",
            scope="test",
            secret_accessor=secret_accessor,
        )


@pytest.mark.asyncio
async def test_validate_api_key_missing_user_id():
    """Missing user_id in metadata raises APIKeyNotFound."""
    secret_accessor = AsyncMock(
        return_value=json.dumps({
            "scope": "admin",
            # missing user_id
        })
    )

    with pytest.raises(APIKeyNotFound):
        await validate_api_key(
            "no-user-key",
            scope="test",
            secret_accessor=secret_accessor,
        )


# ============================================================================
# A2A Bearer Token & API Key Authentication Tests
# ============================================================================


@pytest.mark.asyncio
async def test_a2a_authenticate_bearer_token_success():
    """Valid bearer token (JWT) returns Identity with aal='a2a'."""
    from datetime import timedelta

    user_id = str(uuid4())
    email = "test@example.com"

    # Mock a request with Bearer token
    request = MagicMock()
    request.headers.get.return_value = "Bearer fake-jwt-token"

    # Mock JWT verification
    mock_identity = MagicMock()
    mock_identity.user_id = user_id
    mock_identity.email = email
    mock_identity.session_id = "sess-123"
    mock_identity.issued_at = datetime.now(tz=UTC)
    mock_identity.expires_at = datetime.now(tz=UTC) + timedelta(hours=1)

    with patch(
        "eidan_backend.http.a2a_auth.verify_access_token",
        return_value=mock_identity,
    ):
        identity = await authenticate_a2a_request(
            request,
            public_pem=b"fake-pem",
            secret_accessor=None,
        )

    assert identity.user_id == user_id
    assert identity.email == email
    assert identity.aal == "a2a"
    assert identity.raw_claims["a2a"] is True


@pytest.mark.asyncio
async def test_a2a_authenticate_api_key_success():
    """Valid API key returns Identity with aal='a2a'."""
    user_id = str(uuid4())

    request = MagicMock()
    request.headers.get.return_value = "ApiKey test-api-key-value"

    secret_accessor = AsyncMock(
        return_value=json.dumps({
            "key_id": "test-key",
            "user_id": user_id,
            "scope": "remote",
            "created_at": "2026-01-01T00:00:00+00:00",
        })
    )

    identity = await authenticate_a2a_request(
        request,
        public_pem=None,
        secret_accessor=secret_accessor,
    )

    assert identity.user_id == user_id
    assert identity.email is None
    assert identity.aal == "a2a"
    assert identity.raw_claims["auth_method"] == "api_key"


@pytest.mark.asyncio
async def test_a2a_authenticate_missing_header():
    """Missing Authorization header raises A2AAuthError."""
    request = MagicMock()
    request.headers.get.return_value = None

    with pytest.raises(A2AAuthError) as exc_info:
        await authenticate_a2a_request(
            request,
            public_pem=b"fake-pem",
            secret_accessor=None,
        )

    assert exc_info.value.jsonrpc_code == 401
    assert "missing Authorization header" in str(exc_info.value)


@pytest.mark.asyncio
async def test_a2a_authenticate_invalid_jwt():
    """Invalid JWT token raises A2AAuthError."""
    request = MagicMock()
    request.headers.get.return_value = "Bearer invalid-token"

    with patch(
        "eidan_backend.http.a2a_auth.verify_access_token",
        # verify_access_token raises InvalidToken on a bad signature; the
        # mock must match that real failure mode (a bare Exception isn't
        # what the auth path catches → it would propagate uncaught).
        side_effect=InvalidToken("signature invalid"),
    ):
        with pytest.raises(A2AAuthError) as exc_info:
            await authenticate_a2a_request(
                request,
                public_pem=b"fake-pem",
                secret_accessor=None,
            )

    assert exc_info.value.jsonrpc_code == 401


@pytest.mark.asyncio
async def test_a2a_authenticate_malformed_bearer():
    """Malformed Bearer token (no value) raises A2AAuthError (400)."""
    request = MagicMock()
    request.headers.get.return_value = "Bearer"  # No token value

    with pytest.raises(A2AAuthError) as exc_info:
        await authenticate_a2a_request(
            request,
            public_pem=b"fake-pem",
            secret_accessor=None,
        )

    assert exc_info.value.jsonrpc_code == 400
    assert "malformed Bearer token" in str(exc_info.value)


@pytest.mark.asyncio
async def test_a2a_authenticate_malformed_api_key():
    """Malformed ApiKey header (no value) raises A2AAuthError (400)."""
    request = MagicMock()
    request.headers.get.return_value = "ApiKey"  # No key value

    with pytest.raises(A2AAuthError) as exc_info:
        await authenticate_a2a_request(
            request,
            public_pem=None,
            secret_accessor=AsyncMock(),
        )

    assert exc_info.value.jsonrpc_code == 400
    assert "malformed ApiKey header" in str(exc_info.value)


@pytest.mark.asyncio
async def test_a2a_authenticate_oversized_header():
    """Authorization header exceeding max length raises A2AAuthError (400)."""
    request = MagicMock()
    request.headers.get.return_value = "Bearer " + ("x" * 9000)  # Exceeds 8192 limit

    with pytest.raises(A2AAuthError) as exc_info:
        await authenticate_a2a_request(
            request,
            public_pem=b"fake-pem",
            secret_accessor=None,
        )

    assert exc_info.value.jsonrpc_code == 400
    assert "exceeds maximum length" in str(exc_info.value)


@pytest.mark.asyncio
async def test_a2a_authenticate_unsupported_scheme():
    """Unsupported Authorization scheme raises A2AAuthError."""
    request = MagicMock()
    request.headers.get.return_value = "Digest invalid-hash"

    with pytest.raises(A2AAuthError) as exc_info:
        await authenticate_a2a_request(
            request,
            public_pem=None,
            secret_accessor=None,
        )

    assert exc_info.value.jsonrpc_code == 401
    assert "unsupported Authorization scheme" in str(exc_info.value)


@pytest.mark.asyncio
async def test_a2a_authenticate_missing_verifier():
    """Bearer token without JWT support raises A2AAuthError (401, not supported)."""
    request = MagicMock()
    request.headers.get.return_value = "Bearer some-token"

    with pytest.raises(A2AAuthError) as exc_info:
        await authenticate_a2a_request(
            request,
            public_pem=None,  # JWT not supported in this deployment
            secret_accessor=None,
        )

    assert exc_info.value.jsonrpc_code == 401
    assert "not supported" in str(exc_info.value)


@pytest.mark.asyncio
async def test_a2a_authenticate_missing_api_key_accessor():
    """API key without vault support raises A2AAuthError (401, not supported)."""
    request = MagicMock()
    request.headers.get.return_value = "ApiKey some-key"

    with pytest.raises(A2AAuthError) as exc_info:
        await authenticate_a2a_request(
            request,
            public_pem=None,
            secret_accessor=None,  # API key not supported in this deployment
        )

    assert exc_info.value.jsonrpc_code == 401
    assert "not supported" in str(exc_info.value)


# ============================================================================
# A2A Vault Manager Tests
# ============================================================================


@pytest.mark.asyncio
async def test_a2a_vault_get_credential_success():
    """Retrieve stored A2A credential from vault."""
    credential_data = {
        "agent_name": "reviewer",
        "base_url": "https://reviewer.example.com",
        "auth_method": "bearer",
        "auth_value": "secret-token",
    }

    secret_accessor = AsyncMock(return_value=json.dumps(credential_data))

    manager = A2AVaultManager(secret_accessor)
    credential = await manager.get_credential("reviewer")

    assert credential is not None
    assert credential.agent_name == "reviewer"
    assert credential.base_url == "https://reviewer.example.com"
    assert credential.auth_method == "bearer"
    assert credential.auth_value == "secret-token"


@pytest.mark.asyncio
async def test_a2a_vault_get_credential_not_found():
    """Missing credential returns None."""
    secret_accessor = AsyncMock(return_value=None)

    manager = A2AVaultManager(secret_accessor)
    credential = await manager.get_credential("nonexistent")

    assert credential is None


@pytest.mark.asyncio
async def test_a2a_vault_get_credential_invalid_json():
    """Invalid JSON in vault is logged and returns None."""
    secret_accessor = AsyncMock(return_value="not-valid-json{")

    manager = A2AVaultManager(secret_accessor)
    credential = await manager.get_credential("bad-credential")

    assert credential is None


@pytest.mark.asyncio
async def test_a2a_vault_get_authorization_header_bearer():
    """Authorization header for bearer credential."""
    credential_data = {
        "agent_name": "reviewer",
        "base_url": "https://example.com",
        "auth_method": "bearer",
        "auth_value": "token-xyz",
    }

    secret_accessor = AsyncMock(return_value=json.dumps(credential_data))

    manager = A2AVaultManager(secret_accessor)
    header = await manager.get_authorization_header("reviewer")

    assert header == "Bearer token-xyz"


@pytest.mark.asyncio
async def test_a2a_vault_get_authorization_header_api_key():
    """Authorization header for API key credential."""
    credential_data = {
        "agent_name": "architect",
        "base_url": "https://example.com",
        "auth_method": "api_key",
        "auth_value": "key-abc",
    }

    secret_accessor = AsyncMock(return_value=json.dumps(credential_data))

    manager = A2AVaultManager(secret_accessor)
    header = await manager.get_authorization_header("architect")

    assert header == "ApiKey key-abc"


@pytest.mark.asyncio
async def test_a2a_vault_get_authorization_header_missing():
    """Missing credential returns None for authorization header."""
    secret_accessor = AsyncMock(return_value=None)

    manager = A2AVaultManager(secret_accessor)
    header = await manager.get_authorization_header("missing")

    assert header is None


# ============================================================================
# JSON-RPC Error Response Tests
# ============================================================================


def test_jsonrpc_error_response_basic():
    """Build JSON-RPC error response."""
    response = a2a_jsonrpc_error_response(401, "Unauthorized")

    assert response["jsonrpc"] == "2.0"
    assert response["error"]["code"] == 401
    assert response["error"]["message"] == "Unauthorized"
    assert response["id"] is None


def test_jsonrpc_error_response_with_data():
    """Build JSON-RPC error response with data field."""
    data = {"key": "value", "code": "auth.invalid_key"}
    response = a2a_jsonrpc_error_response(401, "Invalid key", data=data)

    assert response["error"]["data"] == data


# ============================================================================
# Integration Tests (Auth + Vault)
# ============================================================================


@pytest.mark.asyncio
async def test_a2a_auth_via_api_key_then_vault_credential():
    """End-to-end: authenticate with API key, then retrieve outbound credential."""
    user_id = str(uuid4())
    request = MagicMock()
    request.headers.get.return_value = "ApiKey test-key"

    secret_accessor = AsyncMock(
        return_value=json.dumps({
            "key_id": "test-key",
            "user_id": user_id,
            "scope": "remote",
            "created_at": "2026-01-01T00:00:00+00:00",
        })
    )

    identity = await authenticate_a2a_request(
        request,
        public_pem=None,
        secret_accessor=secret_accessor,
    )

    assert identity.user_id == user_id
    assert identity.aal == "a2a"


def test_a2a_credential_serialization():
    """A2A credentials serialize/deserialize correctly."""
    original = A2ACredential(
        agent_name="reviewer",
        base_url="https://review.example.com",
        auth_method="bearer",
        auth_value="secret-token",
    )

    # Serialize to dict
    data = original.to_dict()
    assert data["agent_name"] == "reviewer"

    # Deserialize back
    restored = A2ACredential.from_dict(data)
    assert restored.agent_name == original.agent_name
    assert restored.base_url == original.base_url
    assert restored.auth_method == original.auth_method
    assert restored.auth_value == original.auth_value
