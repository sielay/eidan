# Contributing to eidan

Welcome. Some basics before you open a PR against core.

## License posture

- **Core (this repo) is AGPL-3.0** and stays AGPL forever — not dual-licensed. Anything merged here
  ships to the world under AGPL. (The vendored `external/matbot` runtime is Apache-2.0; its LICENSE
  is preserved in-tree.)
- **Sielay Ltd also ships proprietary plugin bundles** and bespoke private plugins on top of AGPL
  core. They live in separate private repos and aren't affected by what you contribute here.
- **Community plugins are derivative works of AGPL core and must be AGPL-compatible.**

## Contributor License Agreement (CLA)

Every external contributor to core signs the [Individual CLA](CLA.md) before their first PR merges
(the CLA bot prompts you once per GitHub identity). In plain English: your contribution ships in
core under AGPL like everyone's, and you also grant Sielay Ltd a broad license to use / sublicense /
relicense it so the proprietary bundles can keep shipping. It does not transfer copyright, change
AGPL for everyone else, or relicense core out of AGPL (`CLA.md §7`).

## How to open a PR

1. Open an issue first for anything non-trivial. Big-bang PRs are usually not merged.
2. Branch from `main`, keep commits focused.
3. Push and open the PR; the CLA bot asks you to sign on first contribution.
4. CI must pass (the license-header check + CLA). Run `pnpm -r run typecheck` locally first.

## License header on new source files

Every **new** `.ts` / `.tsx` / `.js` file must start with `SPDX-License-Identifier: AGPL-3.0-or-later`
(a block comment). `License Header Check` enforces it on additions. The only exempt path is the
vendored `external/matbot/**` (Apache-2.0) — see `.github/license_header_exempt.txt`. A plugin bundle
(separate repo) carries its own proprietary header instead.

## Erasable-only TypeScript

Plugins run on Node's native type-stripper (no build step). **No TypeScript parameter properties,
enums, or namespaces** — `tsc` allows them but the runtime rejects them. Use explicit fields. See
`CLAUDE.md`.

## Out of scope for this repo

Paid bundle code and the landing site live in separate, private repos. PRs adding paid-bundle
features here will be redirected. Cross-cutting features that genuinely belong in core are welcome —
ask in an issue first.

## Questions

Open a GitHub issue for technical questions. Licensing: `hello@eidan.dev`.
