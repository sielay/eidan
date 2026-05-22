# Contributing to eidan

Welcome. Some basics before you open a PR against core.

## License posture

- **Core (this repo) is licensed AGPL-3.0** and stays AGPL forever.
  Core is not dual-licensed. Public-facing core code, and any
  contribution merged into it, ships to the world under AGPL.
- **Sielay Ltd (the project maintainer) also ships proprietary
  plugin bundles** and bespoke private plugins for enterprise
  clients. These plugins sit on top of AGPL core, live in separate
  repos, and are not affected by what you contribute here.
- **Community plugins are derivative works of AGPL core and must be
  distributed under AGPL-compatible terms.** See
  [docs/COMMUNITY_PLUGINS.md](docs/COMMUNITY_PLUGINS.md) for the
  plugin-author walkthrough and
  [docs/020_LICENSING_AND_CLA.md](docs/020_LICENSING_AND_CLA.md) for
  the full legal reasoning.

## Contributor License Agreement (CLA)

Every external contributor to core must sign the [Individual
CLA](CLA.md) before their first PR can be merged. The CLA bot will
prompt you to click-through on your first PR; you sign once per
GitHub identity, and the signature applies to every subsequent PR.

**What the CLA does, in plain English:**

- Your contribution ships in core under AGPL, like everyone else's.
- You also grant Sielay Ltd a broad license to use, sublicense, and
  relicense your contribution — so Sielay Ltd can keep shipping its
  proprietary plugin bundles and bespoke enterprise plugins without
  needing to come back and ask permission later.
- You confirm the contribution is yours to submit (or you have
  permission from your employer to submit it).

**What the CLA does *not* do:**

- It does not transfer copyright. You still own your contribution.
- It does not change AGPL for everyone else. The world still sees
  core under AGPL-3.0.
- It does not relicense eidan core out of AGPL. Core is AGPL forever
  (`CLA.md §7`).
- It does not require you to provide ongoing support.

## How to open a PR

1. Open an issue first if the change is non-trivial (anything
   beyond a typo or a small fix). Big-bang PRs are usually not
   merged.
2. Branch from `main`, keep commits focused.
3. Push the branch and open a PR. The CLA bot will ask you to sign
   on first contribution.
4. CI must pass (`pytest` is the required gate; ruff, schemas
   codegen sync, and the license-header check also run).

## License header on new source files

Every **new** Python / TypeScript source file added in a PR must
carry an `SPDX-License-Identifier: AGPL-3.0-or-later` line near the
top (the standard SPDX comment format for the language). The
`License Header Check` workflow enforces this on additions only —
existing files without a header are tracked for a one-time backfill,
not blocked.

Generated artefacts (under `packages/schemas/src/generated/`,
`packages/schemas/eidan_schemas/generated/`) and Next.js scaffolding
are exempt; see `.github/license_header_exempt.txt` for the full
list. If your PR introduces a file that genuinely cannot carry a
header, extend that file in the same PR.

## Merge gate

`main` is protected. The **`pytest`** status check is a required
gate — a PR cannot merge until the workflow goes green, and admin
bypass is disabled. Force-push and branch deletion are also blocked.

If the gate misfires on something unrelated to your change (e.g. a
transient infrastructure failure), re-run the workflow rather than
asking for a bypass.

## Out of scope for this repo

Paid bundle code and the landing site live in **separate, private
repos**. PRs adding paid-bundle features here will be redirected. Cross-cutting features that genuinely belong in
core are welcome — when in doubt, ask in an issue first.

## Questions

Open a GitHub issue for technical questions. Licensing questions:
`hello@eidan.dev`.
