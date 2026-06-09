# 030 — A2A Security Schemes

Status: Draft

Owner: Core

Related: [028 — Agents as first-class actors](./028_AGENT_ACTORS.md) (on_behalf_of
attribution), [011 — Auth Flow](./011_AUTH_FLOW.md) (JWT validation), [012 — Secrets](./012_SECRETS.md) (vault),
[029 — Agent Delegation & Mesh](./029_AGENT_DELEGATION_AND_MESH.md) (agent-to-agent delegation).

**In brief:** eidan's A2A (Agent-to-Agent) protocol supports two inbound security schemes
(Bearer JWT and API Key) for remote agents to authenticate, and stores credentials for
outbound delegation via the native vault. All credentials are encrypted at rest; never
plaintext config.

---

## 1. Inbound Security — Remote Agent Calls eidan

When a remote agent calls eidan's A2A endpoint (e.g., `POST /a2a`), it must authenticate.
Eidan supports two schemes:

### 1.1 Bearer JWT

A remote agent can send a bearer token (JWT) if it has one. The eidan host validates it
against the same RS256 public key as user auth (`docs/011 §11`).

**Request:**
```
POST /a2a
Authorization: Bearer <jwt>
```

**Validation:**
1. Extract token from `Authorization: Bearer <token>` header.
2. Verify signature against `request.app.state.auth_public_pem`.
3. On success, create an `Identity` with `aal="a2a"` (to distinguish from user auth).
4. On failure, return JSON-RPC 2.0 error code 401.

**Per `docs/028`:**
The authenticated identity represents the *principal* (user) on whose behalf the remote
agent is acting. Cost, RLS, and data ownership follow this identity. The remote agent's
own identity is recorded in `messages.metadata` as `initiated_by`.

### 1.2 API Key

A remote agent can authenticate with an API key (stateless, symmetric). The key is looked up
in the vault (`eidan.secrets_vault`), decrypted, and mapped to a user_id.

**Request:**
```
POST /a2a
Authorization: ApiKey <key>
```

or (equivalently):
```
POST /a2a
Authorization: Bearer <key>
```

(Bearer header is tried as JWT first; on failure, a fallback check treats it as an API key.)

**Validation:**
1. Extract key from header.
2. Look up in vault under scope `a2a_remote.api_keys.<key_prefix>`.
3. Decrypt and check expiry (if present).
4. Return associated user_id.
5. Create an `Identity` with `aal="a2a"` and `raw_claims["auth_method"]="api_key"`.

**Key storage format (vault):**
```
Scope: a2a_remote
Key:   api_keys.<key_id>
Value: JSON
  {
    "user_id": "<uuid>",
    "scope": "optional-role",
    "created_at": "2026-06-09T00:00:00Z",
    "expires_at": "2026-12-31T23:59:59Z"  (optional)
  }
```

### 1.3 Failure Responses

Both schemes fail with a JSON-RPC 2.0 error response (code 401 for auth failure, 500 for
misconfiguration):

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": 401,
    "message": "invalid or unknown API key"
  },
  "id": null
}
```

---

## 2. Outbound Security — eidan Calls Remote A2A Agents

When eidan delegates to a remote A2A agent, it needs credentials to authenticate the
outbound request. Credentials are stored encrypted in the vault and retrieved at delegation
time.

### 2.1 Credential Storage

Credentials are stored in the vault under scope `a2a_remote`. Each remote agent has one entry:

**Vault storage (raw, before encryption):**
```
Scope: a2a_remote
Key:   agents.<agent_id>
Value: JSON
  {
    "agent_name": "<agent_id>",
    "base_url": "https://remote-agent.example.com",
    "auth_method": "bearer",  # or "api_key"
    "auth_value": "<secret-token-or-key>"
  }
```

**Operator provisioning (CLI):**
```bash
# Store an outbound credential for the 'reviewer' agent
eidan secret set a2a_remote.agents.reviewer '{
  "agent_name": "reviewer",
  "base_url": "https://review-agent.example.com",
  "auth_method": "bearer",
  "auth_value": "secret-bearer-token"
}'

# Or API key:
eidan secret set a2a_remote.agents.architect '{
  "agent_name": "architect",
  "base_url": "https://architect-agent.example.com",
  "auth_method": "api_key",
  "auth_value": "static-api-key-xyz"
}'
```

**Environment fallback** (for testing only; use vault in production):
```bash
EIDAN_A2A_REMOTE_AGENTS_REVIEWER='{"agent_name":"reviewer",...}'
```

### 2.2 Credential Retrieval

At delegation time, the A2A client (via the agentic loop) retrieves the credential:

```python
from eidan_backend.a2a_vault import A2AVaultManager

# In the delegation tool handler:
vault_manager = A2AVaultManager(ctx.secret)  # ctx.secret is the accessor
credential = await vault_manager.get_credential("reviewer")
if not credential:
    raise ToolError("no credential found for remote agent 'reviewer'")

# Use the credential:
auth_header = await vault_manager.get_authorization_header("reviewer")
async with httpx.AsyncClient() as client:
    response = await client.post(
        f"{credential.base_url}/a2a",
        headers={"Authorization": auth_header},
        json={"jsonrpc": "2.0", "method": "message/send", ...}
    )
```

### 2.3 Encryption at Rest

All credentials in the vault are encrypted with `EIDAN_AUTH_MASTER_KEY` (HKDF-derived Fernet).
The plaintext credential is never logged or cached; it is decrypted on-demand at delegation time.

If the master key is lost or rotated, re-provision credentials:
```bash
eidan secret set a2a_remote.agents.reviewer '<new-credential-json>'
```

---

## 3. Trust Model — On Behalf Of

Per `docs/028`, when a remote agent calls eidan:

- **`on_behalf_of`** = the authenticated identity (from JWT or API key)
- **`initiated_by`** = the remote agent (recorded in message metadata, not affecting billing/RLS)

Example: Remote agent `code-reviewer` authenticates with user `alice`'s JWT.
```
Turn runs:
  on_behalf_of = alice  (cost charged to alice, alice's RLS applies)
  initiated_by = {kind: "agent", ref: "code-reviewer"}  (for audit trail)
```

This ensures:
- Delegation is auditable (know which remote agent initiated the work).
- Cost and data ownership are unambiguous (charge the right user).
- An unauthenticated or unprivileged remote caller cannot escalate access.

---

## 4. Agent Card Declaration

The Agent Card published at `/.well-known/agent-card.json` declares the supported schemes:

```json
{
  "name": "eidan",
  "security_schemes": {
    "bearer": {
      "type": "http",
      "scheme": "bearer",
      "description": "Bearer token authentication (JWT or API key)"
    },
    "api_key": {
      "type": "apiKey",
      "description": "API key authentication (stored in vault)"
    }
  },
  ...
}
```

Remote agents read this card, discover the available schemes, and choose one.

---

## 5. Implementation Notes

### 5.1 API Key Lifecycle

API keys are **not** auto-rotated. The operator is responsible for:
- **Provisioning:** `eidan secret set a2a_remote.api_keys.<key_id> {...}`
- **Revocation:** delete the key from vault
- **Rotation:** provision a new key, migrate clients, delete the old one

A future enhancement could add automatic expiry or rotation via a management API.

### 5.2 Per-Agent Overrides (Future)

Per `docs/012 §1`, agent contexts can override secrets. This could allow a user to
provide their own credential for a remote agent (e.g., a private code reviewer):

```json
{
  "id": "<agent_uuid>",
  "user_overrides": {
    "secrets": {
      "a2a_remote.agents.my_reviewer": "..."
    }
  }
}
```

This is currently not enforced in the A2A path but is reserved for future use.

### 5.3 Outbound Client Error Handling

When a delegation fails (missing credential, remote auth failure, timeout):
1. The A2A client normalizes the error into the loop's `ToolError` envelope.
2. The error is recorded in `llm_calls.error_message`.
3. The agent sees the error and can retry, escalate, or fail gracefully.

Example error:
```
ToolError(
  tool="delegate_to_reviewer",
  message="A2A delegation failed: remote returned 401 Unauthorized"
)
```

---

## 6. Security Posture

### What This Protects Against

- **Unauthorized delegation:** unauthenticated remote agents cannot call eidan.
- **Plaintext secrets in config:** all credentials are vault-encrypted.
- **Privilege escalation:** an authenticated remote agent can only act on behalf of the
  authenticated principal (no more, no less).
- **Credential replay/sniffing (with HTTPS):** bearer tokens and API keys are sent over TLS.

### What This Does **Not** Protect Against

- **Stolen credentials:** if a remote agent's JWT/API key is compromised, an attacker can
  act on behalf of the legitimate user. Operators must rotate keys and monitor for misuse.
- **MITLS attacks:** this spec does **not** yet support mTLS. Future phase: add client
  certificate validation.
- **Plaintext logging:** take care not to log Authorization headers or credentials.
  The vault accessor logs at `debug` level only.

---

## 7. Phasing

| Phase | Scope | Status |
|-------|-------|--------|
| **1** | Bearer JWT + API key inbound, vault-backed outbound credentials | **This PR** |
| **2** | mTLS inbound scheme + certificate pinning | proposed |
| **3** | Automatic key rotation + expiry enforcement | proposed |
| **4** | Per-agent credential overrides (user-private remote agents) | proposed |

---

## 8. Open Questions

None.
