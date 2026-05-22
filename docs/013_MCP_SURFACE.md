# 013 — MCP surface (server + client)

Status: Draft
Owner: Core
Related: `docs/ARCHITECTURE.md` (Plugins, Release model),
`docs/001_PLUGINS.md` (§1.1 manifest, §2.2 PluginContext,
§5 behaviours, §7 MCP server exposure),
`docs/003_MEMORY_DDL.md` (§3 messages, §4 events, §5 knowledge,
§6 notes, §7 agent_context, §9 llm_calls),
`docs/004_SCHEMAS.md` (`agentic/*`, `mcp/*` DTOs),
`docs/005_AGENTIC_LOOP.md` (§2 layers, §5.4 tool surface,
§5.5 primary loop, §5.10 agent router),
`docs/006_BEHAVIOURS_TRIGGERS.md` (§2 ToolSpec, §4 registry),
`docs/007_PROVIDER_ABSTRACTION.md` (§2 provider protocol,
§8 NormalisedError),
`docs/011_AUTH_FLOW.md` (§4 Identity, §5 JWT validation,
§9 service-role distinction, §10 error shape),
`docs/012_SECRETS.md` (§4.3 scope taxonomy, §5 accessor API,
§7 OAuth rotation)

This document specifies the **bidirectional Model Context Protocol
surface** of Eidan. Two distinct directions are in scope:

- **INBOUND.** Eidan exposes MCP servers so external clients
  (potem, Claude Desktop, an editor plugin, another agent) can
  read and write the memory model and run turns. There are two
  classes of inbound server: the **host MCP server** owned by
  core, and **plugin MCP servers** owned by individual plugins
  per `001 §7`.
- **OUTBOUND.** Eidan acts as an MCP client against upstream
  MCP servers wrapped by plugins. The wrapped tools land in the
  agentic loop's tool surface (`005 §5.4`) alongside behaviour-
  contributed tools (`006 §2`), and are indistinguishable from
  in-process tools to the primary model.

The document pins:

- What resources and tools the host MCP server exposes, and the
  declarative allowlist that bounds them.
- The transports the host supports (stdio for local trusted
  clients, HTTP+SSE for remote authenticated clients) and the
  auth model each one uses.
- How plugins wrap external MCP servers — manifest declarations,
  per-deployment vs per-user credential storage, and the
  discovery handshake at connect time.
- The lifecycle of an outbound connection (open, list, register,
  call, reconnect, tear down) and the error surface that maps
  upstream MCP errors into `007 §8.1`'s NormalisedError hierarchy.
- The sequencing decision: **server-first**, with a minimal core
  toolset that unblocks the potem migration before the outbound
  client lands.

The shape is opinionated because every MCP edge in Eidan has a
known direction, a known authenticator, and a known owner.
"Ambient" MCP connections — undeclared, unauthenticated, or
unscoped — are not a category the host supports.

Out of scope (deferred to follow-ups, see §10):

- The wire format of individual MCP frames (the official MCP
  specification is the source of truth; this document references
  it but does not redescribe it). The Pydantic and Zod types Eidan
  uses internally are generated from `packages/schemas/schemas/mcp/`
  per `004 §8.1`.
- MCP **sampling** (the protocol's reverse-tool surface where the
  server asks the client to run an LLM call) and **elicitation**
  (server-driven UI prompts). Both are valid MCP features but
  raise governance questions (who pays, who sees, who logs) that
  belong in a follow-up.
- MCP **prompts** as a first-class concept. The host's prompt
  composition lives in `005 §5.4` and is not exposed as MCP
  prompt templates today.
- Cross-plugin tool composition (a tool from plugin A invoking a
  tool from plugin B via the loop). Tools call through
  `ctx.tools.execute` per `005 §5.5`; composing without going
  through the loop is reserved.
- A self-hosted MCP registry / marketplace beyond the plugin
  registry (`001 §9` reserves the latter; this document inherits
  the reservation).

---

## 1. Vocabulary

| Term                  | Meaning                                                                                                                                                       |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **MCP**               | Model Context Protocol — the JSON-RPC-shaped protocol for exchanging tools, resources, and prompts between a client and a server. Spec-side reference only.   |
| **MCP server**        | A process (or in-process registration) that exposes tools and resources over an MCP transport. Eidan hosts at least one (the host server, §3) and zero or more plugin servers (§3.6). |
| **MCP client**        | A process that connects to an MCP server, lists its surface, and calls its tools. Eidan acts as one when a plugin wraps an upstream MCP server (§4).          |
| **Host MCP server**   | The single core-owned MCP server. Exposes the memory primitives (`knowledge`, `events`, `notes`, `conversations`, `messages`) and `turn.run`. See §3.4.       |
| **Plugin MCP server** | A per-plugin MCP server (`001 §7`). Same transports as the host server; tools come from `mcp.tools[]` in the plugin's manifest.                              |
| **Upstream server**   | A third-party MCP server a plugin wraps (Gmail-MCP, calendar-MCP, …). Eidan is the *client* against it. See §4.                                              |
| **Inbound tool**      | A tool the host (or a plugin) publishes via the MCP server surface. Called from outside Eidan.                                                                |
| **Outbound tool**     | A tool surfaced into the agentic loop's tool surface (`005 §5.4`) that was originally registered by an upstream MCP server. Called from inside the primary loop. |
| **Tool catalogue**    | The declarative allowlist of MCP tool names a server publishes. Lives in `mcp.tools[]` in the manifest (host or plugin).                                      |
| **Resource catalogue**| The declarative allowlist of MCP resource URIs / templates a server publishes. Lives in `mcp.resources[]` in the manifest.                                    |
| **Transport binding** | A single physical channel an MCP server speaks: stdio (subprocess pipe), HTTP+SSE (server-sent events), or — reserved — WebSocket.                            |
| **Connection record** | The host-side row that tracks one outbound connection: `(plugin_slug, server_id, transport, state, last_listed_at)`. See §4.5.                                |

---

## 2. The two surfaces, at a glance

```
                       ┌───────────────────────────────────────────┐
                       │   external client (potem, Claude Desktop, │
                       │   editor, another agent)                  │
                       └───────────────┬───────────────────────────┘
                                       │ MCP (stdio | HTTP+SSE)
                                       │ Authorization: Bearer <jwt>
                                       │   (for HTTP only — §3.3)
                                       ▼
              ┌────────────────────────────────────────────────────┐
              │                                                    │
              │   Eidan host MCP server     ←—— core ——→ host code │
              │   (`eidan` server name)                            │
              │                                                    │
              │   tools:                                           │
              │     - eidan.memory.write_knowledge                 │
              │     - eidan.memory.write_event                     │
              │     - eidan.memory.read_notes                      │
              │     - eidan.memory.search                          │
              │     - eidan.turn.run                               │
              │   resources:                                       │
              │     - eidan://conversations/{id}                   │
              │     - eidan://notes/{id}                           │
              │     - eidan://knowledge/{skill}                    │
              │                                                    │
              ├────────────────────────────────────────────────────┤
              │                                                    │
              │   Plugin MCP servers (one per plugin, optional)    │
              │   (`001 §7`; tools from manifest mcp.tools[])      │
              │                                                    │
              └─────────────┬──────────────────────────────────────┘
                            │
                            │  in-process: ctx.tools.execute (005 §5.5)
                            ▼
              ┌────────────────────────────────────────────────────┐
              │  Primary loop tool surface (005 §5.4)              │
              │                                                    │
              │  ┌───────────────────────────────────────────────┐ │
              │  │  Outbound MCP clients (per-plugin, optional)  │ │
              │  │                                               │ │
              │  │  Each plugin may declare upstream MCP servers │ │
              │  │  in its manifest. The host opens one          │ │
              │  │  connection per upstream per process, calls   │ │
              │  │  list_tools/list_resources at connect time,   │ │
              │  │  and registers each tool into the surface     │ │
              │  │  namespaced <plugin>.<server>.<tool>.         │ │
              │  └───────────────────────────────────────────────┘ │
              └────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌────────────────────────────────────────────────────┐
              │  Upstream MCP servers (Gmail-MCP, calendar-MCP, …) │
              │  Transport: stdio (subprocess) | HTTP+SSE          │
              │  Auth:      per-plugin, per-user (vault) or        │
              │             per-deployment (env). See §4.2.        │
              └────────────────────────────────────────────────────┘
```

Three load-bearing properties:

- **The host MCP server is one server, not many.** Tools live
  under the single namespace `eidan`. Plugins contribute their
  own MCP servers under `001 §7`'s `mcp.name`; the host does not
  re-export plugin tools through its server.
- **Outbound and inbound never share a connection.** A plugin
  that both contributes an inbound MCP server and wraps an
  upstream MCP server runs two distinct stacks — one server, one
  client. The host's accountancy treats them as orthogonal.
- **Identity flows the same way at both ends.** Inbound: a JWT
  on the HTTP transport (`011 §4`). Outbound: the agentic loop's
  current `Identity` (`011 §4.3`) propagates into the wrapping
  plugin, which selects the right per-user credential from the
  vault (`012 §6`) when calling the upstream.

---

## 3. INBOUND: eidan as MCP server

### 3.1 Host server vs plugin servers

| Aspect                 | Host MCP server                                  | Plugin MCP server (`001 §7`)                            |
|------------------------|--------------------------------------------------|----------------------------------------------------------|
| Server name            | `eidan`                                          | `<plugin-name>`                                          |
| Owner                  | Core                                             | The named plugin                                         |
| Tool namespace         | `eidan.<area>.<verb>`                            | `<plugin-namespace>.<verb>` (the plugin's choice)         |
| Lives in               | `eidan/host/mcp/server.py`                       | The plugin's `mcp.entrypoint` module                     |
| Manifest               | `apps/host/mcp.host.yaml` (pseudo-plugin, §3.6)  | The plugin's `plugin.yaml`                               |
| Enabled by default     | Yes                                              | No (`mcp.enabled: false` is the manifest default)        |
| Discoverable           | Always, when a transport is bound                | Only when the plugin is `active` and `mcp.enabled: true` |
| Transports             | stdio + HTTP+SSE (§3.2)                          | stdio + HTTP+SSE (`001 §1.1` permits both)              |

The host server's manifest lives in the repo alongside the host
binary, modelled as a **pseudo-plugin** in the same shape `007
§7.1` already takes for provider adapters. The pseudo-plugin
manifest's `mcp:` block is the source of truth for the host
server's tool catalogue (§3.4) and resource catalogue (§3.5);
nothing is exposed that the manifest does not declare. This is
the same discipline `001 §7` imposes on plugin servers, applied
uniformly to the host's own surface.

A deployment that does not want any inbound MCP runs with the
host server bound to no transport — the catalogue is still
declared, but no external process can reach it. This is the
default when the operator sets `EIDAN_MCP_INBOUND_TRANSPORTS=`.

### 3.2 Transports

Two transports ship in core. A third (WebSocket) is reserved
(§10).

| Transport      | Where bound                                                    | Who connects                                                    |
|----------------|----------------------------------------------------------------|------------------------------------------------------------------|
| **stdio**      | A subprocess pipe; the host writes a launcher script the operator hands to local clients. | One local client per launch (Claude Desktop, an editor, a CLI tool). The launcher inherits the operator's filesystem and env. |
| **HTTP+SSE**   | A bound TCP port (default `:8443`, configurable via `EIDAN_MCP_HTTP_BIND`). | Any client that holds a valid native access token (`011 §3`). |

Three rules pin the matrix:

- **stdio is strictly local-trusted.** It is launched as a child
  process of a client that already has filesystem access to the
  host's working directory. The host treats stdio as the
  operator's own session — see §3.3 for the auth implication.
- **HTTP+SSE is the network surface.** Every other client (an
  external potem worker, a remote browser, a second machine on
  the LAN) connects here. The transport is HTTPS by default; an
  operator who wants plain HTTP on a trusted LAN flips
  `EIDAN_MCP_HTTP_TLS=off` and accepts the loss of in-flight
  confidentiality.
- **Both transports may be active simultaneously.** The host
  multiplexes the same catalogue through both; a tool call from
  stdio and a tool call from HTTP land on the same in-process
  handler. Audit rows (§6) carry the transport label so a query
  can tell which side issued the call.

`EIDAN_MCP_INBOUND_TRANSPORTS` is a comma-separated list. The
default is `stdio,http` for a self-hosted install and `http`
only for a containerised deployment where stdio has no
meaningful local consumer.

### 3.3 Auth model

The inbound auth model is one rule applied per transport, with
no exceptions.

| Transport     | Identity source                                                            | Audit `actor_kind` (`012 §8.1`) |
|---------------|----------------------------------------------------------------------------|----------------------------------|
| stdio         | Implicit: the *operator*. The host resolves a configured operator user_id and never accepts a different one. | `admin`                          |
| HTTP+SSE      | `Authorization: Bearer <jwt>` (native access token, `011 §4`).             | `plugin` if delegated, otherwise `core` (see below). |

Three load-bearing properties:

- **The host does not mint MCP-specific tokens.** The native auth
  subsystem is the only issuer of identity per `011 §2`. An MCP
  client authenticating over HTTP carries the same access token a
  browser would, verified against the same cached RS256 public PEM
  (`011 §5`).
- **stdio uses the configured operator identity, not anonymity.**
  The host refuses to bind stdio without `EIDAN_OPERATOR_USER_ID`
  set in the environment. `011 §8` already explains why
  anonymous turns do not exist; the same reasoning applies — an
  unattributed MCP write would pollute memory and bypass cost
  attribution. The operator's user_id is a known identity even
  when the transport carries no token.
- **No long-lived MCP API keys in core.** A future need for
  service-to-service identity over MCP (cron callers, headless
  workers) re-uses whatever `011 §12`'s service-actor spec lands
  on. Until then, HTTP requires a refreshable user JWT. This
  matches the design constraint of the issue: "Auth model (JWT?
  separate token?)" — answer: JWT for HTTP, implicit operator
  for stdio, nothing else.

The middleware that validates the JWT for MCP requests is the
same `AuthMiddleware` (`011 §4.4`) reused via a thin SSE adapter:
the SSE handshake carries `Authorization` on the initial GET, the
adapter calls into the existing `validate_access_token` and
attaches the resulting `Identity` to the long-lived SSE session.

#### Per-tool authorisation

Each tool in the host server's catalogue (§3.4) carries a
required-capability tag in the manifest:

```yaml
mcp:
  tools:
    - name: eidan.memory.write_knowledge
      requires: memory.write
    - name: eidan.memory.read_notes
      requires: memory.read
    - name: eidan.turn.run
      requires: turn.run
```

Today there is exactly one `Identity` shape — the authenticated
user — and every capability is granted by default. The `requires`
field exists so the future scope catalogue (`011 §12`,
`auth.plugin_scope_denied`) can attach per-tool scopes without
a manifest change. A request for a tool whose `requires` tag the
caller's `Identity.claims` does not satisfy is denied with the
existing `auth.plugin_scope_denied` code per `011 §10.2`.

### 3.4 Tool catalogue (host server)

The host server's tool catalogue is the minimal set that lets an
external client read and write the memory model and drive turns.
Everything in the catalogue maps onto an existing DDL surface
from `003`; nothing here is new persistence.

| Tool name                          | Maps to                                       | Mutates           | Notes                                                                       |
|------------------------------------|-----------------------------------------------|-------------------|------------------------------------------------------------------------------|
| `eidan.memory.write_knowledge`     | `INSERT INTO eidan.knowledge` (`003 §5`)      | yes               | Caller picks `skill` and `title`; FK `user_id` is the caller's identity.    |
| `eidan.memory.write_event`         | `INSERT INTO eidan.events` (`003 §4`)         | yes               | At least one of `due_at` / `occurred_at` is required (`events_time_chk`).   |
| `eidan.memory.write_note`          | `INSERT INTO eidan.notes` (`003 §6`)          | yes               | `agent_id` defaults to the operator's primary agent; overridable.            |
| `eidan.memory.read_notes`          | `SELECT FROM eidan.notes`                     | no                | Paginated; `since` / `until` filters; soft-deleted rows excluded by default. |
| `eidan.memory.read_events`         | `SELECT FROM eidan.events`                    | no                | Same filters; `status` filter included.                                      |
| `eidan.memory.search`              | `SELECT FROM eidan.knowledge` via `body_tsv`  | no                | Full-text over `eidan.knowledge`; pgvector recall is a §10 follow-up.        |
| `eidan.conversation.get`           | `SELECT FROM eidan.conversations`             | no                | Returns the conversation row plus a bounded recent-messages window.          |
| `eidan.conversation.append`        | `eidan.messages` (user role) + `run_turn`     | yes (drives turn) | Wraps `005 §3` step ② plus the rest of the loop. Streams via SSE.            |
| `eidan.turn.run`                   | Calls `run_turn` (`005 §4`)                   | yes (drives turn) | Convenience that creates a new conversation when no `conversation_id` given. |

Three properties pin the catalogue:

- **Reads return DTOs, not raw rows.** The DTOs live under
  `packages/schemas/schemas/mcp/` and are generated from the
  same JSON Schemas the rest of the host uses (`004 §8.1`). No
  column from `eidan.*` reaches the wire without passing through
  a generated DTO.
- **Writes flow through the same accessors HTTP routes use.**
  `eidan.memory.write_knowledge` does not call `INSERT` directly;
  it calls the same `KnowledgeRepo.create` that `POST
  /api/knowledge` would, with the same validation. The MCP layer
  is a transport, not a privileged path.
- **`eidan.conversation.append` is the potem-migration shape.**
  potem today drives turns via a bespoke HTTP route; the
  intended migration is to point potem at `eidan.conversation.append`
  over MCP. Streaming chunks land via SSE (the MCP protocol's
  notification frames) rather than a custom WebSocket protocol.

Tools not in this list are not exposed by the host server.
Plugins that want to publish their own tools to external MCP
clients do so via their own MCP server (`001 §7`).

### 3.5 Resource catalogue (host server)

MCP resources are read-only URI-keyed payloads. The host exposes:

| Resource URI template                | Maps to                                         | Notes                                                              |
|--------------------------------------|--------------------------------------------------|---------------------------------------------------------------------|
| `eidan://conversations/{id}`         | `SELECT FROM eidan.conversations WHERE id=$1`    | Includes a bounded recent-messages window (default last 50).        |
| `eidan://conversations/{id}/messages`| `SELECT FROM eidan.messages WHERE conversation_id=$1` | Paginated via `?cursor=`; honours soft-delete.                |
| `eidan://notes/{id}`                 | `SELECT FROM eidan.notes WHERE id=$1`            | Single row; respects `deleted_at IS NULL`.                          |
| `eidan://knowledge/{skill}`          | `SELECT FROM eidan.knowledge WHERE skill=$1`     | Lists titles under a skill; bodies fetched via `eidan://knowledge/{skill}/{title}`. |
| `eidan://knowledge/{skill}/{title}`  | `SELECT FROM eidan.knowledge WHERE skill=$1 AND title=$2` | Body markdown.                                              |
| `eidan://events?status=pending`      | `SELECT FROM eidan.events ...`                   | Query-string is a fixed grammar; arbitrary SQL via resource URIs is rejected. |

The same DTO discipline as §3.4 applies: a resource read returns
a generated DTO, not a raw row.

Resources are convenience for *read* paths only. A client that
wants to drive a turn or write memory uses a tool, not a
resource — this matches the MCP spec's intent (resources are
addressable read-only documents; tools are side-effectful).

### 3.6 Plugin-contributed servers

`001 §7` already specifies the per-plugin MCP server shape. This
document adds two pin-down clarifications:

- **Plugin servers share the same transports.** A plugin whose
  manifest sets `mcp.transport: stdio` ships a launcher the host
  exposes per the same scheme as §3.2's stdio. A plugin whose
  manifest sets `mcp.transport: sse` is mounted on the host's
  HTTP+SSE port under the path `/mcp/<plugin-name>` — the host
  is the single ingress; plugins do not bind their own ports.
- **Plugin servers inherit the auth model.** A plugin server's
  HTTP+SSE binding goes through `AuthMiddleware` (§3.3) before
  reaching the plugin's `mcp.entrypoint`. A plugin cannot
  weaken or bypass auth.

The pseudo-plugin host manifest and a real plugin manifest are
the same shape — the host server is simply the first MCP server
the loader registers, before any plugin's `on_activate` runs.

---

## 4. OUTBOUND: eidan as MCP client

### 4.1 Plugin manifest declaration

A plugin that wraps one or more upstream MCP servers declares
them under a new `mcp_clients[]` field in its manifest. This is
distinct from `mcp:` (the *server* the plugin exposes per §3.6).

```yaml
# plugin.yaml — extension to 001 §1.1

mcp_clients:
  - id: gmail-mcp                     # plugin-local identifier, [a-z0-9-]
    display_name: Gmail (MCP)
    transport: stdio                  # stdio | sse
    # transport=stdio: launcher + args
    command: ["npx", "-y", "@modelcontextprotocol/server-gmail"]
    env:                              # env vars passed to the launched process
      - name: GMAIL_OAUTH_CLIENT_ID   # from the plugin's declared env (§3.2 above)
        passthrough: true             # forward verbatim to the child
    # transport=sse: connection
    url: null                         # required when transport=sse
    headers: null                     # required when transport=sse; see §4.2
    auth:
      kind: oauth                     # oauth | api_key | none
      vault_key: oauth.access_token   # the plugin-scope vault entry (012 §6)
      refresh_via: get_access_token   # plugin function returning a fresh token
    discovery:
      list_tools_at_connect: true     # default
      list_resources_at_connect: true # default
      refresh_interval_s: 3600        # re-list every hour; 0 disables
    tool_filter:
      include: ["gmail.search", "gmail.send", "gmail.read"]
      exclude: []
    tags:
      - may_egress_user_data          # propagated onto each registered ToolSpec
```

Three rules:

- **The `mcp_clients[]` block is the only legal place a plugin
  opens a network MCP connection.** A plugin that calls into an
  MCP SDK directly is caught by lint, same shape as the
  undeclared-vault-access rule in `012 §6.2`.
- **`auth.kind` is a closed set.** `oauth` (refresh via the
  plugin's `oauth.access_token` and `oauth.refresh_token` vault
  entries, `012 §7`), `api_key` (a single vault entry), `none`
  (no credentials — local subprocess that talks to a local
  service). Future kinds are additive; unknown kinds fail
  manifest validation.
- **`tags` propagate into the agentic loop.** Each tool the host
  registers from this upstream inherits the manifest's `tags`,
  feeding the scope-based filter in `005 §5.4` (e.g.
  `may_egress_user_data` is excluded when
  `scope.sensitivity = high`).

### 4.2 Connection config and credentials

The split mirrors `012 §2`'s two tiers.

| Credential                              | Tier        | Owner                       | Vault key (when dynamic)                                  |
|-----------------------------------------|-------------|-----------------------------|------------------------------------------------------------|
| Per-deployment, never per-user          | Static (`012 §3`)   | Host or plugin              | n/a — env var                                              |
| OAuth client id / secret of the upstream provider | Static    | Operator                    | n/a — env var `<PLUGIN_SLUG>_OAUTH_CLIENT_ID` / `_SECRET` |
| Per-user OAuth access token             | Dynamic     | Plugin                      | `<user_id>:plugin:<slug>:oauth.access_token`               |
| Per-user OAuth refresh token            | Dynamic     | Plugin                      | `<user_id>:plugin:<slug>:oauth.refresh_token`              |
| Per-user API key (user-supplied)        | Dynamic     | Plugin                      | `<user_id>:plugin:<slug>:mcp.<server-id>.api_key`           |
| Per-deployment API key (operator-supplied) | Static   | Plugin                      | n/a — env var `<PLUGIN_SLUG>_<SERVER_ID>_API_KEY`           |

Two opinions:

- **The host never holds upstream credentials in process memory
  for longer than one outbound call.** Per-user credentials are
  fetched from the vault (`012 §5.2`) at the moment the agentic
  loop calls the wrapped tool, used for the upstream call, and
  not cached. The host's existing 24-h-grace audit window
  (`012 §5.5`) gives an operator a forensic trail without a
  long-lived in-memory copy.
- **The plugin, not the host, refreshes OAuth tokens.** The
  refresh helper named in `auth.refresh_via` is the plugin's
  function. It implements the CAS pattern in `012 §7.2` exactly;
  the host invokes it whenever an upstream call fails with
  `oauth.invalid_grant` or whenever the access-token vault
  read returns `None` (TTL-expired).

### 4.3 Discovery at connect time

The handshake is straightforward and idempotent:

```python
# eidan/host/mcp/client/loader.py — simplified
async def attach_upstream(plugin: PluginRecord, decl: McpClientDecl) -> None:
    conn = await open_connection(decl)         # stdio: spawn; sse: GET
    await conn.initialize(
        client_info={"name": "eidan", "version": HOST_VERSION},
        capabilities={"sampling": False, "elicitation": False},
    )
    tools     = await conn.list_tools()        if decl.discovery.list_tools_at_connect else []
    resources = await conn.list_resources()    if decl.discovery.list_resources_at_connect else []
    # Filter against decl.tool_filter; reject anything else.
    keep = filter_tools(tools, decl.tool_filter)
    for t in keep:
        register_tool_in_loop_surface(
            namespaced_name=f"{plugin.name}.{decl.id}.{t.name}",
            input_schema=t.input_schema,
            description=t.description,
            tags=decl.tags,
            handler=make_dispatcher(conn, t.name),
        )
    record_connection(plugin, decl, conn, tools=keep, resources=resources)
```

Three properties:

- **The host re-lists periodically.** `discovery.refresh_interval_s`
  defaults to one hour. A re-list that changes the tool set is
  reflected in the next turn's tool surface; in-flight turns
  keep the snapshot they started with.
- **Server-asserted tool names are namespaced before registration.**
  Two upstream servers that both publish `search` cannot collide
  in the loop's surface: their names become
  `<plugin>.<server>.search`. The agentic loop's tool dispatch
  (`005 §5.5`) sees the full namespaced name; the upstream sees
  its bare `search`.
- **`tool_filter` is enforced at registration, not at call time.**
  An upstream that publishes a new tool not on the include list
  is logged but not registered. This is the inverse of `001 §7`'s
  `mcp.tools[]` (which constrains *inbound* tools the host
  publishes) — `tool_filter` constrains *outbound* tools the
  host imports.

### 4.4 Registration into the agentic loop's tool surface

Each registered outbound tool becomes a `ToolSpec` (`006 §2.1`):

```python
ToolSpec(
    name             = f"{plugin}.{server_id}.{upstream_tool_name}",
    description      = upstream_tool.description,
    input_schema_id  = synthesised_schema_id,   # see below
    tags             = frozenset(decl.tags) | {"source.mcp"},
)
```

The `source.mcp` tag is automatically attached. It lets `005
§5.4`'s filter exclude all MCP-sourced tools at once (a future
"airgap mode" where only in-process tools are allowed).

The upstream's tool input schema is JSON Schema in MCP's wire
format. The host wraps it under a synthesised `$id`:
`https://schemas.eidan.dev/runtime/mcp/<plugin>/<server>/<tool>/v<n>.json`
where `<n>` increments on every change. The schema is *not*
hand-authored under `packages/schemas/` — it is runtime-published
from what the upstream returned, and the codegen pipeline
(`004 §8.1`) does not see it. This is the one place runtime
schemas exist outside the codegen pipeline; the alternative
(force every upstream to be schema-authored ahead of time) is
incompatible with the MCP ecosystem.

The primary loop calls the tool exactly like any other:

```python
result = await ctx.tools.execute(tool_use, ctx_for_tool(ctx))
```

`ctx.tools.execute` dispatches on the tool name's prefix. A name
beginning with `<plugin>.<server>.` routes to the outbound MCP
dispatcher, which:

1. Reads the per-user credential from the vault (`012 §5.2`).
2. Calls the upstream's `tools/call` over the existing
   connection.
3. Normalises the upstream's response into an `AssistantTurn`-
   compatible tool result (`007 §2`'s `AssistantTurn` block
   shape).
4. Maps any upstream MCP error into a `NormalisedError`
   subclass (`007 §8.1`) — `McpUpstreamError` is a new sibling
   of `ProviderTransientError`, added as part of this spec's
   follow-up to `007 §8`.

A tool call's audit trail lands in `eidan.llm_calls` only when
the wrapping primary call accounts for it; tool execution itself
writes a `messages` row (role `tool`, `005 §5.5`) with the
upstream identity recorded in `metadata.mcp = {"plugin": ...,
"server": ..., "tool": ...}`. The vault read leaves its own audit
trail per `012 §8`.

### 4.5 Connection lifecycle

```
plugin activates ──▶ host opens 1 connection per mcp_clients[] entry
                  ──▶ initialize + list_tools/list_resources
                  ──▶ register namespaced ToolSpecs into loop surface
                  ──▶ connection enters `ready` state

every refresh_interval_s ──▶ re-list; diff against current registry
                          ──▶ register / unregister / update as needed

upstream EOF / error ──▶ connection enters `degraded`
                      ──▶ tools tagged unavailable in the next list_tools call
                      ──▶ host attempts reconnect with exponential backoff
                          (cap = 5 min, jitter ±20%)

plugin deactivates ──▶ host closes every connection it opened for the plugin
                    ──▶ unregisters tools from loop surface
                    ──▶ in-flight tool calls receive `McpUpstreamError`
```

Three rules:

- **One connection per upstream per host process.** A second
  turn that reaches the same upstream piggybacks on the existing
  connection; the upstream sees a single long-lived MCP session.
- **Reconnect is the host's responsibility, not the plugin's.**
  The plugin contributes `auth.refresh_via` for credential
  rotation; the *transport* reconnect (stdio respawn, SSE
  re-open) is uniform and lives in the host's MCP client
  loader. Plugins do not see disconnection.
- **Degraded ≠ removed.** A tool from a degraded upstream
  stays in the loop's surface but is marked `state: degraded`;
  the sizer (`005 §5.3`) and the model can route around it.
  Only `plugin deactivate` removes a tool outright. This avoids
  a flapping upstream churning the tool surface every minute.

### 4.6 Failure handling

The outbound client's error surface piggybacks on the
NormalisedError hierarchy (`007 §8.1`). One new subclass is added:

```python
# eidan/host/providers/errors.py — additive
class McpUpstreamError(NormalisedError):
    """An upstream MCP server returned an error or the transport
    failed. Carries the upstream's error code verbatim plus the
    namespaced tool name; never the upstream's full payload (a
    leaked auth token in an error body is a real concern).
    """
    upstream_code: str        # MCP error code, e.g. -32000
    tool: str                 # namespaced tool name
```

Specific mappings:

| Upstream condition                          | Maps to                              | Recovery                                                                 |
|---------------------------------------------|--------------------------------------|---------------------------------------------------------------------------|
| `tools/call` returns MCP `error.code=-32601` (method not found) | `McpUpstreamError("method_not_found")` | The tool was de-listed; host removes it from the surface on the next list. |
| `tools/call` returns `-32000` (server error) | `ProviderTransientError`            | Retried per `007 §3` retry budget; primary loop sees a tool error block. |
| HTTP 401 / 403 from the upstream            | `McpUpstreamError("unauthorized")`   | Plugin's `auth.refresh_via` invoked; one retry; then surfaced as tool error. |
| Connection EOF mid-call                      | `ProviderTransientError`             | Reconnect + one retry inside the current tool call.                       |
| Connection EOF outside a call                | n/a — connection enters `degraded`   | Reconnect in the background; tools tagged accordingly.                    |
| Vault read for the upstream credential returns `None` | `McpUpstreamError("not_connected")` | Surfaced as a tool error with a "user has not connected this provider" hint; UI shows reconnect prompt. |

The primary loop sees tool errors as normal `tool_result` blocks
with `is_error: true` (`005 §5.5`'s `error_block`). A tool error
does not abort the turn; the model decides whether to retry, ask
for clarification, or apologise.

---

## 5. Error responses

The inbound surface re-uses `011 §10`'s error shape verbatim.
A tool call that fails authorisation, validation, or execution
returns the same body shape on the MCP wire (wrapped in MCP's
`tools/call` error envelope) as the corresponding HTTP route
would:

```jsonc
{
  "error": {
    "code": "auth.token_expired",
    "message": "Access token has expired. Refresh and retry.",
    "request_id": "01HQ...",
    "details": { "expires_at": "2026-05-11T11:42:09Z" }
  }
}
```

Two MCP-specific codes are added to the closed set in `011 §10.2`:

| HTTP | `code`                         | When                                                                                |
|------|--------------------------------|--------------------------------------------------------------------------------------|
| 404  | `mcp.tool_not_found`           | Inbound call to a tool name not in the catalogue, or the catalogue at a name that is not enabled for the caller's scope. |
| 503  | `mcp.upstream_unavailable`     | The agentic loop tried to call an outbound tool whose connection is in `degraded` state and reconnect attempts are exhausted. |

Outbound errors do not surface to the HTTP boundary directly —
they reach the primary loop as `tool_result` blocks with
`is_error: true`, and the model's response is the user-visible
outcome. The codes above are observable in `eidan.llm_calls.error`
and the `eidan_mcp_upstream_errors_total` metric (§6).

---

## 6. Observability

The host emits four MCP-specific metrics in addition to the
existing auth and vault series (`011 §11`, `012 §11`):

| Metric                                  | Type      | Labels                                                  | Notes                                                          |
|-----------------------------------------|-----------|----------------------------------------------------------|-----------------------------------------------------------------|
| `eidan_mcp_inbound_calls_total`         | counter   | `transport` (stdio/http), `tool`, `outcome`             | One increment per tool call into the host's MCP server.        |
| `eidan_mcp_inbound_latency_seconds`     | histogram | `transport`, `tool`                                     | Wall-clock from `tools/call` receive to response.              |
| `eidan_mcp_outbound_calls_total`        | counter   | `plugin`, `server_id`, `tool`, `outcome`                | One per upstream `tools/call` issued by the host.              |
| `eidan_mcp_upstream_errors_total`       | counter   | `plugin`, `server_id`, `reason`                         | Hot signal: a spike here = a flapping upstream.                |

The metric set does not include a per-resource counter — MCP
resources are read-paths and ride the same per-tool axis when
they are read via `resources/read` (the MCP spec's read frame).

Audit attribution mirrors `011 §11` and `012 §11`. Every inbound
tool call gets a trace span tagged with the caller's `Identity`;
every outbound call gets a span tagged with the *agentic-loop's*
identity (the user whose turn is in flight). The two spans live
in the same trace tree when a turn drives an outbound MCP call —
join key is the same `request_id` (`011 §10.5`) the cost ledger
uses (`007 §6.4`, `010 §3`).

---

## 7. Sequencing decision: server-first

The issue calls out a sequencing question. The answer is
**server-first**, with two qualifications.

### 7.1 The decision

Ship the **inbound host MCP server** first, with a deliberately
minimal tool catalogue:

1. `eidan.memory.write_knowledge`
2. `eidan.memory.write_event`
3. `eidan.memory.read_notes`
4. `eidan.memory.search`
5. `eidan.conversation.append`  (the streaming entrypoint)

This catalogue is the **strict subset** §3.4 documents, narrowed
to what the potem migration actually needs. The remaining §3.4
tools (`write_note`, `read_events`, `conversation.get`,
`turn.run`) land in the same release branch but ship behind an
`EIDAN_MCP_HOST_TOOLS_PROFILE=full` flag; the default profile
matches the five above.

Transports:

- stdio bound to operator identity (§3.3) — Claude Desktop, the
  CLI, and the potem worker on the same Pi.
- HTTP+SSE on `:8443` — every remote client.

Plugin MCP servers (`001 §7`) and outbound MCP clients (§4) are
sequenced after this lands.

### 7.2 Why server-first

Three reasons:

- **Unblocks potem.** The motivating use case is potem migrating
  off its bespoke HTTP shape onto MCP. potem is an MCP *client*;
  it needs the host server to call. Client-first ships nothing
  potem can consume.
- **Lower surface area to harden.** The inbound auth model is
  already specified (`011`) — the MCP server reuses it directly.
  The outbound client requires per-upstream credential plumbing
  through the vault (`012 §6.2` + the §4.2 table above), which
  is genuinely new code on top of an external surface
  (third-party MCP servers) the host does not control.
- **Outbound has a viable interim.** Plugins that need an
  external integration before outbound MCP lands can still talk
  to the upstream over its native API (HTTPS + per-user vault
  credential). The migration to outbound MCP is purely an
  internal refactor when it lands; the plugin's manifest grows
  an `mcp_clients[]` block and the in-process HTTP calls go
  away. No user-visible change.

### 7.3 Why not client-first

Two reasons:

- **Dogfooding the outbound client without an inbound surface
  means dogfooding against external upstream servers that vary
  in quality.** We learn more by hardening our own MCP surface
  against a known external client (Claude Desktop, potem) than
  by being a client against a fleet of MCP servers whose shape
  changes weekly.
- **The agentic loop's tool surface already works.** `005 §5.5`
  is a working tool dispatch path; adding MCP-sourced tools to
  it is incremental. The motivating constraint of the project
  (potem migration) is on the inbound side.

### 7.4 Cutover criteria for outbound

Outbound (§4) is unblocked when:

- The inbound host server has been in production for ≥ 2 weeks
  with no Sev-1 auth/persistence regressions.
- `eidan.llm_calls` rolls up cleanly per turn (`007 §6.4`) for
  inbound-driven turns — confirms that calls originating outside
  the HTTP boundary do not leak the cost-attribution invariants.
- One concrete plugin has both an upstream MCP server worth
  wrapping (Gmail-MCP is the working assumption) and a real
  user need that justifies the integration. Speculative outbound
  wrappers are not a sequencing trigger.

The criteria are observable, not subjective. The PR that lands
outbound MCP references the criteria in its description.

---

## 8. Migration impact on existing specs

This document references but does not change:

- **`001 §7`.** Plugin MCP servers continue to work as
  specified. The host server is added alongside; plugins are
  unaffected. §3.6 above adds two clarifications (shared
  transports, shared auth) that match the intent of `001 §7`
  but were not previously written down.
- **`004` (Schemas).** A new directory `packages/schemas/schemas/mcp/`
  carries the inbound tool input/output DTOs. Runtime-published
  schemas from upstream servers (§4.4) live in memory only.
- **`005 §5.4` and `§5.5`.** Outbound MCP tools enter the same
  tool surface; no change to the loop's pseudocode beyond the
  dispatcher prefix routing (§4.4).
- **`007 §8`.** A new `McpUpstreamError` subclass joins the
  NormalisedError hierarchy. Existing providers are unaffected.
- **`011 §10.2`.** Two new error codes are added
  (`mcp.tool_not_found`, `mcp.upstream_unavailable`); existing
  codes are unchanged.
- **`012 §6`.** Outbound MCP credentials use the existing
  `plugin:<slug>` vault scope. No new scope is introduced. The
  rotation flow in `012 §7` applies verbatim.

This document does change:

- **`001 §1.1`.** The plugin manifest gains an `mcp_clients[]`
  block. The change is additive — existing manifests without
  the block load as before. The §4.1 schema above is the
  canonical shape; the `004` JSON Schema for `PluginManifest` is
  updated to allow it.

The follow-up PR list (filed against issues yet to be opened):

- Add `McpUpstreamError` to `eidan/host/providers/errors.py`.
- Add `mcp.tool_not_found` and `mcp.upstream_unavailable` to
  `011 §10.2`'s closed set.
- Update `PluginManifest.schema.json` with the `mcp_clients[]`
  block.
- Generate `mcp/*` DTOs under `packages/schemas/`.

---

## 9. Operator surfaces

### 9.1 CLI

```
eidan mcp serve [--transports stdio,http] [--http-bind 0.0.0.0:8443]
eidan mcp tools list                                    # inbound catalogue
eidan mcp clients list                                  # outbound connections
eidan mcp clients inspect <plugin>:<server_id>          # tools, resources, state
eidan mcp clients reconnect <plugin>:<server_id>        # force reconnect
```

`eidan mcp serve` is the long-running command the operator
invokes from systemd or equivalent. It binds the configured
transports and blocks. `eidan mcp tools list` reads the
catalogue from the live process via a Unix-domain socket; if
the process is not running, it falls back to parsing the
pseudo-plugin manifest and warns that the live state is
unknown.

### 9.2 Admin UI

A panel under `/admin/mcp` exposes:

- The host server's catalogue (tools + resources, derived from
  the pseudo-plugin manifest).
- Every plugin server (`001 §7`) currently registered.
- Every outbound connection's state (ready / degraded), last
  `list_tools` timestamp, and the set of namespaced tools
  contributed to the loop surface.
- A "reconnect" button per outbound connection — fires the same
  CLI path.

The panel does **not** expose tool input/output payloads or
credentials. Forensic queries against those live in the audit
trail (`012 §8`) and the trace UI (`005 §9` reserves observability;
this document inherits the reservation for the trace UI's exact
shape).

### 9.3 First-time provisioning

A new install has the host MCP server's catalogue populated
from the pseudo-plugin manifest, no plugin servers, and no
outbound connections. The operator:

1. Sets `EIDAN_OPERATOR_USER_ID` and runs `eidan mcp serve`.
2. Optionally configures a local client (Claude Desktop, an
   editor) to launch the stdio transport.
3. Optionally exposes HTTPS on `:8443` for remote clients.

There is no required dynamic-tier state to start. The first
outbound MCP plugin a user installs is the trigger for the first
upstream connection.

---

## 10. Reserved for later specs

Deliberately out of scope, to be specified in follow-ups:

- **MCP sampling and elicitation.** The protocol's reverse-tool
  surface (server-driven LLM calls) and UI prompts. Both raise
  governance questions (cost attribution for sampling, user
  consent for elicitation) that need their own spec.
- **MCP prompts as a first-class surface.** Today the host's
  prompt composition (`005 §5.4`) is the only prompt path.
  Exposing it as MCP prompts is a future ergonomics win for
  external clients that want to consume the same system prompt
  the loop uses.
- **WebSocket transport for inbound.** Reserved against a
  future browser-to-MCP path. HTTP+SSE covers the bidirectional
  needs today; WS is purely an ergonomics question.
- **Cross-plugin tool composition.** A tool from plugin A
  invoking a tool from plugin B without going through the loop.
  Today every cross-plugin call routes via the agentic loop's
  tool surface, which is the documented composition path.
- **MCP service tokens / non-user actors.** Inbound MCP today
  requires a user JWT (or implicit operator identity for stdio).
  A future service-actor model (`011 §12`) ships a dedicated
  token shape; this document inherits that reservation.
- **Outbound MCP transport-level rate limits.** Today an
  abusive upstream is caught by the connection's reconnect
  backoff and the `eidan_mcp_upstream_errors_total` metric, not
  by a rate limiter.
- **Per-upstream cost attribution.** `010 §3`'s cost ledger
  tracks Eidan's own LLM spend. Cost incurred *by the upstream*
  (an MCP server that itself charges per call) is invisible to
  the host today. A future spec defines how upstream-emitted
  cost annotations land in `eidan.llm_calls.metadata`.
- **A self-hosted MCP registry.** The plugin registry (`001 §9`)
  is reserved; an MCP-server-only registry is a strict subset
  and is reserved alongside it.
- **MCP federation.** A host that itself runs as an MCP client
  against another Eidan instance, sharing memory across two
  trusted instances. The trust boundary, the conflict-resolution
  model, and the auth shape are all open questions.
