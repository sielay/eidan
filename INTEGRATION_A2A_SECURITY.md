# A2A Security Schemes Integration Guide

This document describes how to integrate the A2A security schemes (from this PR) with the A2A handler code (from dependency PRs #276, #277, #279).

## Modules Added

### Core Authentication
- **`eidan_backend.http.a2a_auth`** — A2A request authentication
  - `authenticate_a2a_request()` — Validates Bearer JWT or API Key, returns Identity
  - `A2AAuthError` — A2A-specific auth exceptions
  - `a2a_jsonrpc_error_response()` — Builds JSON-RPC 2.0 error responses

### API Key Support
- **`eidan_backend.auth_native.api_keys`** — API key validation & provisioning
  - `validate_api_key()` — Look up key in vault, check expiry
  - `provision_api_key()` — Create & store new API key (operator use)
  - `APIKeyNotFound`, `APIKeyExpired` — Typed exceptions

### Outbound Credentials
- **`eidan_backend.a2a_vault`** — Manage credentials for remote A2A agents
  - `A2AVaultManager` — Retrieve & use encrypted outbound credentials
  - `A2ACredential` — Credential data model

### Tests
- **`tests/test_a2a_auth.py`** — Comprehensive test coverage

## Integration Points

### 1. A2A Route Handler (from #277)

The A2A route (e.g., `POST /a2a`) should authenticate inbound requests before processing:

```python
from eidan_backend.http.a2a_auth import (
    authenticate_a2a_request,
    a2a_jsonrpc_error_response,
    A2AAuthError,
)

@router.post("/a2a")
async def handle_a2a(request: Request) -> JSONResponse:
    """Handle inbound A2A requests (JSON-RPC 2.0)."""
    
    # Authenticate the request
    try:
        identity = await authenticate_a2a_request(
            request,
            public_pem=request.app.state.auth_public_pem,
            secret_accessor=getattr(request.app.state, "secret_accessor", None),
        )
    except A2AAuthError as exc:
        return JSONResponse(
            status_code=exc.jsonrpc_code,
            content=a2a_jsonrpc_error_response(
                exc.jsonrpc_code,
                str(exc),
            ),
        )
    
    # Set the identity on request state (for downstream handlers)
    request.state.identity = identity
    
    # Parse JSON-RPC request
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(
            status_code=400,
            content=a2a_jsonrpc_error_response(400, f"invalid JSON: {exc}"),
        )
    
    # Dispatch to method handler
    method = payload.get("method")
    params = payload.get("params", {})
    
    if method == "message/send":
        return JSONResponse(content=await a2a_message_send(request, params))
    elif method == "message/stream":
        return await a2a_message_stream(request, params)
    else:
        return JSONResponse(
            status_code=400,
            content=a2a_jsonrpc_error_response(
                -32601,
                f"method not found: {method}",
            ),
        )
```

### 2. Agent Card (from #276)

The Agent Card should declare supported security schemes:

```python
from eidan_backend.http.a2a import AgentCard, SecurityScheme, build_agent_card

# In your agent card builder:
agent_card = build_agent_card(
    name="eidan",
    description="Autonomous agent host",
    version="...",
    url="...",
    provider_url="...",
    provider_org="...",
)

# Security schemes are auto-populated with bearer + api_key
# You can customize if needed:
agent_card.security_schemes = {
    "bearer": SecurityScheme(
        type="http",
        scheme="bearer",
        description="Bearer token authentication (JWT or API key)",
    ),
    "api_key": SecurityScheme(
        type="apiKey",
        description="API key authentication (stored in vault)",
    ),
}
```

### 3. Outbound A2A Delegation (integrate with #279)

When delegating to a remote A2A agent, use the vault to retrieve credentials:

```python
from eidan_backend.a2a_vault import A2AVaultManager

# In your delegation tool handler:
async def delegate_to_remote(
    payload: dict,
    *,
    ctx: TurnContext,  # From the agentic loop
) -> str:
    """Delegate to a remote A2A agent."""
    
    # Extract delegation parameters
    agent_id = payload.get("agent_id")  # e.g., "reviewer"
    prompt = payload.get("prompt")
    
    # Retrieve credential from vault
    vault_manager = A2AVaultManager(ctx.secret)
    auth_header = await vault_manager.get_authorization_header(agent_id)
    
    if not auth_header:
        raise ToolError(
            f"no credential found for remote agent '{agent_id}'. "
            "Use `eidan secret set` to provision one."
        )
    
    # Construct outbound request
    credential = await vault_manager.get_credential(agent_id)
    base_url = credential.base_url if credential else "unknown"
    
    # Call remote agent
    import httpx
    async with httpx.AsyncClient(timeout=300) as client:
        try:
            response = await client.post(
                f"{base_url}/a2a",
                headers={"Authorization": auth_header},
                json={
                    "jsonrpc": "2.0",
                    "method": "message/send",
                    "params": {
                        "message": {"parts": [{"type": "text", "text": prompt}]}
                    },
                },
            )
            response.raise_for_status()
            result = response.json()
        except httpx.HTTPError as exc:
            raise ToolError(f"A2A delegation to {agent_id} failed: {exc}")
        except Exception as exc:
            raise ToolError(f"A2A delegation error: {exc}")
    
    # Extract result and return to agent
    if "result" in result:
        return result["result"].get("status", "completed")
    elif "error" in result:
        error = result["error"]
        raise ToolError(
            f"remote agent returned error: {error.get('message')} "
            f"(code {error.get('code')})"
        )
    else:
        raise ToolError("unexpected response from remote agent")
```

### 4. Bootstrap Integration

When the app starts, ensure the secret accessor is available on `app.state`:

```python
# In eidan_backend/http/app.py or bootstrap:
from eidan_backend.secrets import make_secret_accessor

# ... existing setup ...

# Make secret accessor available to A2A handlers
app.state.secret_accessor = make_secret_accessor(pool)
```

## Testing

Run the test suite (once test environment is configured):

```bash
pytest tests/test_a2a_auth.py -v
```

Manual testing:

```bash
# 1. Provision an API key for a remote agent
eidan secret set a2a_remote.api_keys.test_key '{"user_id":"<uuid>","scope":"admin"}'

# 2. Test inbound authentication
curl -X POST http://localhost:8000/a2a \
  -H "Authorization: ApiKey <key>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"parts":[{"type":"text","text":"hello"}]}}}'

# 3. Provision an outbound credential
eidan secret set a2a_remote.agents.reviewer '{
  "agent_name":"reviewer",
  "base_url":"https://reviewer.example.com",
  "auth_method":"bearer",
  "auth_value":"secret-token"
}'
```

## Migration Notes

If upgrading from a version without A2A security:

1. **No schema changes** — all credentials use existing `eidan.secrets_vault` table.
2. **Backward compatible** — existing JWT auth still works.
3. **Operator action** — provision API keys and outbound credentials via `eidan secret` CLI.

## Open Questions / Future Work

1. **mTLS Support** — Phase 2 (not in this PR). Add client certificate validation.
2. **Key Rotation** — Phase 3. Implement automatic expiry and rotation.
3. **Per-Agent Overrides** — Phase 4. Let users override credentials per agent_context.
4. **Rate Limiting** — Consider adding per-caller rate limits (separate from user rate limits).
5. **Audit Logging** — Log all A2A authentication attempts for compliance.
