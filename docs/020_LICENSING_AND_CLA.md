# 020 — Licensing and CLA

> **Status:** Canonical. Pins the licensing posture of eidan core
> and the contribution intake policy that preserves it.

## 1. The model in one sentence

Core is **AGPL-3.0 forever**; Sielay Ltd ships **proprietary plugin
bundles and bespoke enterprise plugins** on top; the right to do
that is preserved by requiring a **CLA on every outside
contribution to core**.

## 2. Why core is AGPL-3.0

The commercial premise of eidan rests on Sielay Ltd's paid sibling
bundles (named and enumerated in `docs/018 §2`, kept out of other
public docs per the §8 forbidden-string posture) and bespoke
private plugins for enterprise clients being **the only proprietary
plugins for eidan core**. The mechanism that enforces this asymmetry is the copyleft
in AGPL:

- A community plugin that imports `eidan.*` and subclasses
  `PluginBase` is a derivative work of AGPL core. When distributed,
  it must be released under AGPL-compatible terms. (FSF's position
  on linked derivatives, supported by the in-process Python plugin
  contract pinned in `docs/001_PLUGINS.md`.)
- A competitor that wants to host eidan as a hosted SaaS service
  triggers AGPL §13: they must offer the source of their
  modifications to every user of the service. This closes the
  "AWS-vs-Elastic" loophole that a plain GPL would leave open.

AGPL is not chosen for ideological reasons. It is the specific
license that makes the open-core business model viable. Switching
to a permissive licence (MIT, Apache, BSD) would surrender the
moat that lets Sielay Ltd be the only seller of proprietary eidan
plugins.

## 3. Why Sielay Ltd can ship proprietary plugins despite AGPL

Because Sielay Ltd owns the copyright on core. AGPL is a license
that Sielay Ltd grants to the world; it does not bind Sielay Ltd
itself. The same code can ship to the public under AGPL and
appear inside Sielay Ltd's proprietary sibling bundles without
contradiction, because the copyright holder retains all rights in
their own code regardless of which licenses they have otherwise
published it under.

This holds **as long as Sielay Ltd remains the sole copyright
holder on core**. The moment outside contributions land under
plain AGPL with no additional grant, the contributor becomes a
co-copyright-holder of the AGPL'd work. From that point on,
Sielay Ltd is bound by AGPL with respect to that contributor's
code — every proprietary plugin Sielay Ltd ships is a derivative
of *their* AGPL code, and they could in principle sue.

The CLA is the standard fix.

## 4. Contributor License Agreement

The CLA text lives at [`CLA.md`](../CLA.md) in the repo root. It is
adapted from the Apache Software Foundation Individual CLA v2.0.
The clauses that matter most for eidan:

- **Copyright grant (`CLA.md §2`).** Contributor grants Sielay Ltd
  a perpetual, irrevocable, sublicensable copyright license to the
  contribution — including the right to relicense it under
  proprietary terms. This is the load-bearing clause; without it,
  Sielay Ltd cannot ship proprietary plugins against future core
  that contains the contribution.
- **Patent grant (`CLA.md §3`).** Contributor grants a
  corresponding patent license, with a defensive-termination clause
  so anyone suing for patent infringement on the contribution loses
  their grant.
- **Outbound license (`CLA.md §7`).** Contributions ship to the
  world under AGPL alongside the rest of core. The contributor's
  copyright stays with the contributor; the CLA does not transfer
  it. **Core itself is committed to remaining AGPL** — the §2
  grant lets Sielay Ltd use the contribution in proprietary plugins
  *outside* this repo, not relicense core.

The Apache ICLA was chosen over Harmony or a slimmed custom CLA
because it is the most widely recognised text, has the most
case-law-tested clauses, and reduces friction with contributors
who have encountered it before in other projects.

## 5. How CLA enforcement is wired

Enforcement uses the [`contributor-assistant/github-action`](https://github.com/contributor-assistant/github-action)
GitHub Action rather than the cla-assistant.io SaaS. Reasons:

- Signatures are stored **inside the repo** (in a designated
  `signatures` branch), so the signature history is version-
  controlled and audit-traceable alongside the code.
- No third-party SaaS dependency. Works the same for public and
  private repos.
- The CLA text the bot links to is the in-repo `CLA.md`, so it
  never drifts out of sync with the canonical text.

The workflow file lives at `.github/workflows/cla.yml`. It posts a
status check on every PR; the check passes once the contributor has
clicked through the CLA acceptance comment posted by the bot on
their PR. The signature is appended to
`signatures/version1/cla.json` on the `cla-signatures` branch.

PRs from `Sielay-Ltd` organisation members and the maintainer's
personal account are exempt from the CLA check (the org or the
account already owns the rights on those contributions).

The bot is the **only** enforcement mechanism — there is no
out-of-band "trusted contributor" exception. If a contributor
refuses the CLA, their PR is closed unmerged.

### 5.1 One-time wiring steps (operator)

1. **Decide signature branch name.** Default: `cla-signatures`.
   Create the branch (empty is fine).
2. **Create a Personal Access Token** with `repo` scope (classic
   PAT) or a fine-grained PAT scoped to the eidan repo with
   contents: write. Store as a repository secret named
   `PERSONAL_ACCESS_TOKEN`. The bot uses this to commit signatures
   back to `cla-signatures`.
3. **Push `.github/workflows/cla.yml`** and trigger a test PR from
   a second account to confirm the bot prompts and the signature
   lands in `signatures/version1/cla.json`.
4. **Configure branch protection** on `main` to require the "CLA
   Assistant" status check. PRs without a signature cannot merge.

The `cla.yml` workflow is pre-staged with sensible defaults and
the allowlist set to the maintainer's account; edit `allowlist` to
reflect actual Sielay Ltd org members once the org is set up.

## 6. What changes if Sielay Ltd ever sells the project

- **Asset sale (copyright transfer).** Sielay Ltd transfers all
  copyrights and CLA-granted rights to the acquirer. The acquirer
  inherits the same legal posture: they can ship proprietary
  plugins, the world still gets AGPL, and the CLA continues to
  apply to new contributions.
- **Project abandonment.** If Sielay Ltd shuts down without
  transferring rights, the AGPL release of core remains in the
  wild forever — anyone can fork it. The CLA-granted broad
  licenses to Sielay Ltd lapse with the entity, but the
  contributors' AGPL grants to the world do not. Nothing the
  community gave up because of the CLA is lost on shutdown: they
  always had AGPL access.

The CLA does **not** include a "Harmony-style outbound license
re-vote" mechanism that would let the maintainer relicense core
out of AGPL by counting signatures. Core is AGPL forever; that is
a unilateral commitment by Sielay Ltd in `CLA.md §7`, not a
maintainer prerogative that could be flipped later.

## 7. What this document does not cover

- The CLA text itself — see [`CLA.md`](../CLA.md).
- The contributor-facing summary — see
  [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- The public-facing license summary — see
  [`LICENSE.md`](../LICENSE.md).
- Trademark policy on "eidan" — separate work, secondary priority.
- Pricing and Stripe fulfilment for paid bundles — see
  `docs/018 §4-5`.

---

**Maintained by:** Sielay Ltd
**Last updated:** 2026-05-13
