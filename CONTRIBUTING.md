# Contributing to eidan

Welcome. Some basics before you open a PR against core.

## License posture

- **Core (this repo) is AGPL-3.0** and stays AGPL forever — not dual-licensed. Anything merged here
  ships to the world under AGPL. (The vendored `external/matbot` runtime is Apache-2.0; its LICENSE
  is preserved in-tree.)
- **Every eidan plugin is AGPL too** — including the mail / calendar / Gmail / Drive integrations,
  which live in this repo. There are no proprietary or paid plugins.
- **Community plugins are derivative works of AGPL core and must be AGPL-compatible.**

## Contributor License Agreement (CLA)

Every external contributor to core signs the [Individual CLA](CLA.md) before their first PR merges
(the CLA bot prompts you once per GitHub identity). In plain English: your contribution ships in
core under AGPL like everyone's, and you also grant Sielay Ltd, as the copyright steward of core,
the right to keep the licence consistent and adopt a later AGPL version (or another OSI-approved
open-source licence) if ever needed. It does not transfer copyright, change AGPL for everyone else,
or relicense core out of open source (`CLA.md §7`).

## How to open a PR

1. Open an issue first for anything non-trivial. Big-bang PRs are usually not merged.
2. Branch from `main`, keep commits focused.
3. Push and open the PR; the CLA bot asks you to sign on first contribution.
4. CI must pass — the license-header check, the forbidden-string gate, CodeQL, and the CLA. Run
   `pnpm -r run typecheck` locally first (the `apps/web` UI installs + typechecks standalone:
   `cd apps/web && pnpm install && pnpm typecheck`).

## License header on new source files

Every **new** `.ts` / `.tsx` / `.js` file must start with `SPDX-License-Identifier: AGPL-3.0-or-later`
(a block comment). `License Header Check` enforces it on additions. The only exempt path is the
vendored `external/matbot/**` (Apache-2.0) — see `.github/license_header_exempt.txt`. A plugin kept
in another repo carries the same AGPL header.

## Erasable-only TypeScript

Plugins run on Node's native type-stripper (no build step). **No TypeScript parameter properties,
enums, or namespaces** — `tsc` allows them but the runtime rejects them. Use explicit fields. See
`CLAUDE.md`.

## Out of scope for this repo

The landing / marketing site lives in a separate repo. Eidan features themselves belong here — in
core or as an AGPL plugin. For anything non-trivial, open an issue first.

## Questions

Open a GitHub issue for technical questions. Licensing: `hello@eidan.dev`.
