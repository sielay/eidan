# 018 — Distribution model and paid bundles

## 1. The model in one sentence

**Core** (this repo, AGPL) is the only host. **Paid bundles** live
in **standalone private sibling repos** owned by the project
maintainer and are installed into a core checkout by the eidan
CLI. There are no forks of this repo, no manual-sync flow, and no
PRO / commercial fork distinction inside this repo's tree.

The licensing posture that makes "AGPL core + proprietary sibling
bundles" legally clean — and the CLA-on-core-PRs policy that
preserves it — is pinned in
[`docs/020_LICENSING_AND_CLA.md`](020_LICENSING_AND_CLA.md). This
document is the *distribution* spec; 020 is the *licensing* spec.
They are siblings.

## 2. The six sibling repos

Six repos make up the product on the maintainer's filesystem.
Their canonical names, GitHub slugs, Stripe product IDs, and team
memberships are **operator-internal** and not enumerated in this
document or anywhere else in this repo (see §7):

| Repo                       | Purpose                                                          | Visibility    |
|----------------------------|------------------------------------------------------------------|---------------|
| This repo (core)           | Host, schemas, core plugins.                                     | open (AGPL)   |
| Paid baseline bundle       | Calendar, IMAP, multiuser + RLS, cost dashboards. Auto-installed alongside any thematic bundle. | private (paid) |
| Three thematic bundles     | One per persona. Plugins only. Customer mix-and-matches them.    | private (paid, one repo per bundle) |
| Landing site               | Marketing + Stripe checkout + GitHub fulfilment.                 | private       |

The **paid baseline bundle** is the universal infrastructure layer
every paid plan needs (calendar, IMAP, multiuser + RLS, cost
dashboards). It is not a separately purchasable SKU; buying any
thematic bundle grants access to the baseline automatically.

The exact set of plugins inside each bundle repo is intentionally
not pinned here — it evolves. The contract this document pins is
the **shape** (standalone repo, plugins-only, dropped into a core
install via the CLI).

## 3. How a bundle is installed

A bundle repo's contents are dropped into a core install's
`plugins/` directory at the same flat shape core uses. The eidan
CLI (separate piece of work, not yet scaffolded) handles:

```
eidan plugin install <bundle>    # clones the named bundle's plugins
                                 # (and paid baseline if not yet present)
eidan plugin update              # pulls latest for every installed bundle
eidan plugin list                # what is installed, at which revisions
eidan plugin remove <bundle>     # rm -rf bundle plugins; run downgrades.
                                 # Paid baseline stays as long as ANY
                                 # thematic bundle remains installed.
```

The paid baseline is **installed as a dependency** of any thematic
bundle. The CLI resolves the dependency at install time: if at
least one thematic bundle is installed, the baseline is present;
if all thematic bundles are removed, the baseline is removed too
(and its plugins' `on_uninstall` hooks run, including any downgrade
migrations).

The CLI authenticates to GitHub with the user's PAT or device-flow
token. Access control is enforced by GitHub: if the user is not a
member of the bundle's team, the clone fails. There is no license
key inside the bundle — possession of the source is the license.
Stripe fulfilment (§5) grants team membership to the paid baseline
*and* the named thematic bundle from a single paid line item.

Plugin migrations run via the existing host hook
(`docs/001_PLUGINS.md §4`). Migrations in a bundle's plugins are
indistinguishable from migrations in a hand-written core plugin —
the host does not know or care which bundle a plugin came from.
The one exception is host-schema migrations registered by paid
plugins, which target `eidan.*` rather than a `plugin_<name>`
schema; see §6.

## 4. Bundle composition is mix-and-match

Pricing is **not tiered**. The customer picks any combination of
one, two, or three **thematic** bundles. Each thematic bundle is a
separate Stripe product. Stripe Checkout accepts multiple line
items, so a single checkout session can grant access to multiple
bundle repos at once.

**The paid baseline is not a separate Stripe product.** It has no
SKU of its own, no price ID, and never appears as a line item. It
is granted as a side-effect of *any* paid line item — the customer
sees thematic bundles in the pricing UI and picks any combination;
the baseline rides along automatically. There is no checkout path
that yields baseline access without at least one thematic bundle.

Combo discounts (if/when introduced) ship as Stripe promotion
codes, not as bundled-SKU products. The webhook handler doesn't
need to know about them — it just iterates `session.line_items`,
grants access to each named bundle, and ensures the team-grant for
the paid baseline is idempotently in place.

## 5. Stripe → GitHub fulfilment

The full flow lives in the landing repo and is the single place
that holds Stripe + GitHub credentials. Core never sees them.

### 5.1 The shipfast-style failure mode

The well-known anti-pattern is: a `/success?session_id=...` route
that, on render, calls the backend "grant access" endpoint
client-side. Attackers craft success URLs for sessions they did not
pay for (or replay an old session) and the backend trusts the
parameter.

### 5.2 Rules that close that hole

1. **Webhook is the only fulfilment trigger.** No success-page
   route, no client-driven endpoint, no admin form may grant
   access. The only code path that adds a GitHub user to a bundle
   team is the signed Stripe webhook handler.
2. **Verify the signature on every webhook call.** Reject any
   request whose `stripe-signature` header does not validate
   against the endpoint's secret.
3. **Re-fetch the session server-side.** Do not trust the webhook
   payload's claims about `customer_email` or custom fields — call
   `stripe.checkout.sessions.retrieve(id, expand=['line_items'])`
   and read the canonical values from the response.
4. **Validate the GitHub username before inviting.** The username
   comes in via a Stripe Checkout custom field. The handler calls
   the GitHub API to confirm the login exists and is a real user
   account (not an org, not deleted). Invalid → 200 OK to Stripe,
   queue a failed-fulfilment row for the operator to resolve
   manually.
5. **Idempotency keyed on `(session_id, price_id)`.** Each row in
   the `fulfillments` table represents one (paid item × session).
   Replays of the same webhook event short-circuit on row presence.
   For each paid line item the handler invites the customer to
   *two* GitHub teams: the named thematic bundle's team and the
   paid baseline team. The baseline invite is idempotent — if the
   customer already has any other paid bundle, the membership
   already exists and the invite call is a no-op.
6. **Refunds revoke access.** The webhook also subscribes to
   `charge.refunded` / `customer.subscription.deleted` and removes
   the user from the corresponding GitHub team. The `fulfillments`
   row is marked revoked rather than deleted, so audit history
   remains. Baseline access is removed only when the *last* paid
   bundle is refunded — partial refunds keep the baseline intact
   as long as at least one paid bundle remains active.
7. **Logs are append-only and signed.** Every webhook event and
   every GitHub API call is written to a log table before the
   next step runs, so a partial failure leaves the operator a
   trail.

### 5.3 Success page is dumb

The post-checkout page renders a "thanks, we're emailing you next
steps" message and triggers nothing. It does not call any backend
endpoint with the session id. It does not even need to know which
bundles were purchased. All of that comes via webhook → email.

## 6. Where RLS and cross-cutting migrations live

**Decision (2026-05-13): RLS and other cross-cutting refinements
on `eidan.*` live in the paid baseline bundle.** The baseline is
the universal paid infrastructure layer every paid plan needs, so
cross-cutting features that need to refine `eidan.*` belong there.
Buying any thematic bundle grants baseline access; the operator
never installs RLS without also installing it.

The remaining sub-question is **mechanical**: how does a paid
plugin actually apply migrations to `eidan.*` rather than to its
own `plugin_<name>` schema? Two candidate shapes remain open and
will be resolved as part of the first host-schema migration
landing, not in this document:

- **Sub-option (a).** The paid baseline ships a folder of
  "host-schema migrations" (e.g. `host_migrations/`) that the host
  registers with Alembic at activation time, separately from the
  plugin's own `plugins/<name>/migrations/` history. The naming
  convention disambiguates revisions so a plugin's host-schema
  migrations and core's own migrations cannot collide.
- **Sub-option (b).** Plugins gain a generic `host_migrations:`
  extension point in `plugin.yaml`. Any plugin that needs to
  refine `eidan.*` declares it; the host applies the migrations
  under a plugin-scoped naming convention. This keeps the paid
  baseline from being mechanically privileged — it just happens
  to be the only plugin in this repo's universe that uses the
  extension point.

A third option — core shipping RLS as opt-in — was rejected: it
puts infrastructure into the AGPL surface where it does not
belong. A fourth — one thematic bundle owning RLS — was rejected:
it incorrectly couples cross-cutting infrastructure to a specific
persona.

The lean today is **sub-option (a)** — minimal extension surface,
matches the operator intuition that "the paid baseline is the
place RLS lives", and the `host_migrations:` extension point in
(b) is speculative generality if the paid baseline is the only
consumer.

`002_MIGRATIONS.md` will be revised in line with the chosen
sub-option when the first paid-baseline host-schema migration
lands.

## 7. Forbidden-string posture (release sanitisation)

The pre-public forbidden-string grep over this repo rejects
business / monetisation / strategy content. Relevant rules:

- `EIDAN_*_LICENSE_KEY` and similar — forbidden, because
  license-gating happens at GitHub repo access rather than at
  runtime key check; these strings should not appear at all.
- `pro` / `commercial` / `PRO` — minimised. Where these terms
  survive in legacy text, they describe the tier metadata that
  the plugin manifest carries (`001 §6`); the words stay in those
  contract contexts but new prose prefers "paid plugin" / "paid
  baseline bundle".
- **Names of specific bundle repos, Stripe product IDs, and
  thematic persona brand names** — operator-internal. They do not
  appear anywhere in this repo's specs, including this document.
  The release sanitisation grep enforces this.

## 8. What this document is not

- Not the spec for the CLI tool. That will land separately when
  the CLI is scaffolded.
- Not the spec for the landing site's content or copy. That lives
  in the landing repo.
- Not the spec for migrations reconciliation. That depends on the
  answer to §6 and lands as a revision of `002_MIGRATIONS.md`.

---

**Maintained by:** Sielay Ltd

**Last updated:** 2026-05-14
