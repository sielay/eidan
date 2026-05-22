# Writing community plugins

This is the practical guide for anyone outside Sielay Ltd who wants
to write a plugin for eidan. It pairs with `docs/001_PLUGINS.md`
(the technical contract) and `docs/020_LICENSING_AND_CLA.md` (the
formal licensing posture); this page is the friendlier "what does
that mean for me?" framing.

If you're writing a plugin you intend to keep entirely private (just
for your own install), most of this doesn't apply — you can write
whatever you want under any license, AGPL doesn't reach private
use. Read on if you plan to **distribute** your plugin in any form:
GitHub, npm/PyPI, an installer, a customer.

---

## TL;DR

1. **Core is AGPL-3.0.** Anything you build *on top of* core
   (importing `eidan.*`, subclassing `PluginBase`) is a derivative
   work when you distribute it. You must distribute under
   AGPL-compatible terms.
2. **AGPL-compatible doesn't mean free.** You can sell your plugin,
   you can keep its source private as long as you don't distribute,
   and you can require a paid license for support / hosted versions.
   What you must do is **make the source available to anyone you
   distribute the binary / hosted service to**.
3. **You retain copyright.** AGPL is a *license*, not a copyright
   transfer. Your code stays yours; AGPL constrains how you let
   others use it.
4. **There's no CLA for plugin code.** The CLA only applies to
   contributions to **this** repo (eidan core). Your plugin lives in
   its own repo, under your own copyright; nobody asks you to sign
   anything to publish it.
5. **Sielay Ltd's proprietary plugins are a separate special case.**
   Sielay Ltd owns the copyright on core, so AGPL doesn't bind them
   the way it binds the rest of us. That asymmetry is what makes the
   open-core bundle business viable. See `docs/020 §3` if you want
   the formal reasoning.

---

## What "derivative work" means for plugins

The FSF's position is that an in-process plugin that imports the
host's library (`import eidan_backend`) and subclasses its
public types (`PluginBase`) creates a derivative work at distribute
time. That's the legal theory eidan's open-core model relies on:
without it, a competitor could ship a hosted eidan-as-a-service
and never publish the modifications they made to make it work.

This is a **legal theory**, not a settled court ruling. If you
disagree with the FSF's framing, talk to a lawyer. The practical
posture this repo takes:

- **Plugins that import `eidan_backend.*` or subclass `PluginBase`
  are treated as derivative work.** Distribute under
  AGPL-compatible terms.
- **A plugin that talks to eidan only over its HTTP API**
  (`/api/turn`, `/api/escalations`, `/api/mcp/tools/call`) is **not**
  importing core — it's a client. You can license it however you
  want; eidan's AGPL doesn't reach across the network boundary.

Most plugins use the in-process surface because that's where the
power lives (registering behaviours, contributing tools, writing
into `plugin_<name>` schemas). Those are derivative. A plugin that
sits entirely on the other side of HTTP — say, a Slack bot that
hits `/api/turn` — is an independent client and outside AGPL's reach.

---

## AGPL-compatible licenses

When your plugin is derivative, the licenses you can ship under
include:

- **AGPL-3.0-or-later** — easiest path. Same shape as core; no
  compatibility math to do.
- **GPL-3.0-or-later** — works when bundled, but distributors must
  honour AGPL's network-use clause too because the combined work
  is "covered" by AGPL.
- **GPL-3.0 + an exception for network use** — uncommon, possible.

Licenses that **are not** AGPL-compatible for a derivative plugin:

- MIT / BSD / Apache 2.0 (alone, for distribution). These are
  fine for plugin code you keep entirely private; not fine for
  plugin code you distribute.
- Proprietary (closed-source, no source-availability clause).
  Sielay Ltd is the only entity that can ship proprietary plugins
  for eidan, because Sielay Ltd owns the copyright on core. Other
  authors can't.

If you want to ship a plugin commercially — that's allowed under
AGPL. You can:

- Charge for the plugin (one-time or subscription).
- Keep source private to your customers (AGPL only requires
  source-availability to the people you distributed to).
- Offer paid support, paid hosting, paid migrations.

You can't:

- Distribute binaries / hosted access while refusing source to
  the recipients.
- Combine with proprietary code that isn't AGPL-compatible.

---

## How to publish a plugin

This is the practical checklist.

1. **Pick a name.** Slug pattern is
   `^[a-z0-9][a-z0-9-]*$`; one or two segments. The eidan CLI uses
   the manifest `name` to derive the install directory and the
   `plugin_<name>` schema name. Avoid names that look operator-
   internal (`core-*`, `internal-*`, `private-*`).
2. **Stand up the manifest.** Copy
   `plugins/example-core/plugin.yaml` as a starter. Set `tier:
   core` (community plugins are functionally core-tier — they ship
   alongside the operator's core install, not behind a paid
   bundle).
3. **Add a license file.** `LICENSE.md` at your repo root carrying
   the AGPL-3.0-or-later text (or a compatible license — see
   above). Plugin authors are *not* required to sign the eidan
   CLA — that's only for contributors to eidan core itself.
4. **Add an SPDX header to every new Python / TypeScript source
   file.** The line is `# SPDX-License-Identifier: AGPL-3.0-or-later`
   (or your chosen compatible license). The host doesn't enforce
   this on community plugins, but downstream redistributors who
   check headers will look for it.
5. **Implement the lifecycle hooks.** At minimum: `on_activate`.
   Most plugins also implement `on_install` (for migrations) and
   `on_deactivate` (for cleanup). See `plugins/capture/eidan_capture/plugin.py`
   as a canonical example.
6. **Document the operator-facing surface.** Your plugin's README
   should cover: what env vars it needs (declared in
   `plugin.yaml` `env[]`), what `vault[]` entries it consumes, what
   behaviours it registers, what tools it adds. Operators install
   plugins from the CLI; their first contact with your work is
   what they read in your README.
7. **Test.** The `plugins/capture/` and `plugins/example-behaviour/`
   plugins have pytest suites under `apps/backend/tests/` that
   show the patterns. A plugin without tests is one update
   away from breaking quietly.
8. **Ship.** Push to your own GitHub repo. Operators install via
   `eidan plugins install --from-dir <path>` (local copy) or by
   pointing `EIDAN_PLUGIN_SOURCE=gh:<your-org>` and running
   `eidan plugins install <your-bundle>`.

---

## Patterns that make plugins easier

- **Use `ctx.notify` for out-of-band nudges.** Don't hand-roll
  Telegram / Slack / email integrations; the host's notification
  router handles channel selection and credential resolution.
  See `docs/024` (TBD) once the spec lands.
- **Use the memory tools.** If your plugin's handler wants to read
  `eidan.events` or `eidan.knowledge`, you can either query
  directly via `ctx.db.acquire()` (you have full read access
  inside the plugin) or call the agent-facing `memory_*` tools.
  Plugin-internal queries are usually the right call; the agent-
  facing tools exist for the *agent* to query, not the plugin.
- **Emit escalations rather than failing silently.** When your
  plugin can't make progress (rate-limited by an upstream API,
  missing credentials, ambiguous input), write an
  `eidan.escalations` row instead of swallowing. The operator's
  inbox surfaces them.
- **Honour the idempotency contract.** Behaviour handlers receive
  a `TriggerEvent.idempotency_key`. The host guarantees at-least-once
  delivery; your handler must be at-most-once-by-key.

## Patterns that bite

- **Don't import from `eidan_backend.internal.*`.** Anything under
  `internal/` is, by convention, host-private; no compatibility
  promise. Use the public `eidan_backend.{plugins,tools,behaviours,
  notifications}` surface.
- **Don't query sensitive tables.** `eidan.llm_calls`,
  `eidan.users.metadata`, `eidan.agent_context.user_overrides` are
  off-limits to plugins. The agent's `memory_query_sql` tool
  enforces this for model-driven queries; plugin code is on the
  honour system but the same restrictions apply for security
  reasons.
- **Don't assume single-instance.** A plugin that writes to its own
  schema is fine. A plugin that holds in-memory state across
  requests has to either (a) put the state in `plugin_<name>` and
  reload on every request, or (b) use a Postgres advisory lock so
  one instance owns the state at a time. The behaviour dispatcher
  already does this for cron / schedule firings; your plugin's
  own scheduled work needs the same discipline.

---

## When in doubt

- Open an issue on the eidan-core repo asking for clarification.
- Talk to a lawyer if the licensing implications matter for your
  business.
- Look at `plugins/capture/`, `plugins/learn/`, and `plugins/sentry/`
  as worked examples in this repo.

The goal of this guide is to make AGPL implications visible without
making them scary. Eidan's open-core model needs community plugins
to thrive; the framing is intentionally permissive while preserving
the asymmetry that lets Sielay Ltd run the paid-bundle business.
