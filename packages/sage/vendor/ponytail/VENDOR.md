# Vendored: ponytail (Claude Code plugin)

Third-party, **unmodified**, MIT. Bundled so the deterministic coder loop can
load it headlessly with no install/marketplace step.

- **Upstream:** https://github.com/DietrichGebert/ponytail
- **Version:** 4.6.0
- **Pinned commit:** `687c1b339872289d70f65c5eaabce850b1663867` (2026-06-15)
- **License:** MIT (see `LICENSE` — retained verbatim per the licence terms).
  This bundle is proprietary; ponytail stays MIT and must not be relicensed.
  Keep it in this bundle — do **not** let it flow up into AGPL core.

## What it does here

Two mechanisms, because the plugin's hook does NOT auto-activate headlessly:

1. **Ruleset injection (load-bearing).** `config.ts` reads `AGENTS.md` and sage
   passes it via `--append-system-prompt` on every `claude` run. This is what
   actually puts the coder in lazy-senior-dev mode, and it is deterministic in
   `claude --print`.
2. **`--plugin-dir <this dir>`** makes the `/ponytail-review`, `/ponytail-audit`,
   `/ponytail-debt` skills invokable, and sets `PONYTAIL_DEFAULT_MODE`.

**Verified on-host:** `--plugin-dir` alone does NOT bias the coder — the
`SessionStart` hook (`hooks/ponytail-activate.js`) does not inject its ruleset in
non-interactive `claude --print` runs; it only registers the skills. Hence the
`--append-system-prompt` path. `node` is required on PATH (matbot already needs it).

Gated by `EIDAN_SAGE_PONYTAIL` (default `full`; `off` disables both mechanisms).
See `packages/sage/src/config.ts` and `packages/sage/README.md`.

## Vendored subset

Only the files the Claude Code `--plugin-dir` path needs on Linux:
`.claude-plugin/plugin.json`, `hooks/` (minus the Windows `.ps1`, Copilot hooks),
`skills/`, plus `LICENSE` and `AGENTS.md`. Dropped: `marketplace.json`,
non-Claude agent rule-files, benchmarks, docs, tests.

## Known wart

`ponytail-activate.js` appends a "STATUSLINE SETUP NEEDED" nudge when
`~/.claude/settings.json` has no `statusLine`. Harmless but noisy for a headless
coder. Left unpatched to keep the pin clean; suppress by giving the worker's
`~/.claude/settings.json` any `statusLine`, or patch the block out here if it
proves distracting. <!-- ponytail: accept the nudge; patch only if it bites -->

## Re-syncing

```
git clone https://github.com/DietrichGebert/ponytail /tmp/ponytail-src
# copy .claude-plugin/plugin.json, hooks/ (drop *.ps1 + copilot-hooks.json),
# skills/, LICENSE, AGENTS.md over this dir; bump the pin above.
```
