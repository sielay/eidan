# Eidan Licensing

## Core — AGPL-3.0

Eidan core (this repository) is licensed under the **GNU Affero
General Public License v3.0**. Core is **not** dual-licensed; it
ships under AGPL-3.0 only, and Sielay Ltd has committed not to
relicense core out of AGPL (see [`CLA.md §7`](CLA.md)).

What this means in practice:

- You may self-host eidan core freely.
- You may modify it for internal use. AGPL only triggers disclosure
  obligations when you **distribute** the modified work or **expose
  it as a network service** to users.
- If you run a modified core as a network service to users
  (employees of your own company do not count), AGPL §13 requires
  you to offer those users the source of your modifications under
  AGPL-compatible terms.
- Plugins that link into core (importing the `@eidandev/*` packages,
  or integrating through core's registered services on matbot's
  service registry) are derivative works of core. When distributed,
  they must be released under AGPL-compatible terms.

Full text of the licence: <https://www.gnu.org/licenses/agpl-3.0.txt>.

## Sielay Ltd's proprietary plugins

Sielay Ltd publishes proprietary plugin bundles that sit on top of
AGPL core. These bundles are **not** in this repository and **not**
covered by the AGPL release of core. They are sold via the eidan
landing site (separate repo). Bundles are vendored into the deploy
image as additional matbot plugins and never live in this repo.

## Bespoke enterprise plugins

Sielay Ltd also builds **private, bespoke plugins** for enterprise
clients who want to self-host eidan in their own infrastructure
with custom integrations, custom row-level security, or other
custom functionality. These are commissioned engagements — not a
licence on core itself, and not a public price-list product.
Contact `hello@eidan.dev` to discuss.

## Why this asymmetry is legitimate

Sielay Ltd owns the copyright on core, so AGPL (which Sielay Ltd
grants to the world) does not bind Sielay Ltd's own use of its own
code. The right to ship proprietary plugins against future core is
preserved by requiring a **Contributor License Agreement (CLA)** on
every outside contribution to core (see
[`CLA.md`](CLA.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md)).

## Contributing

Outside contributions to core require a signed CLA before merge.
See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Questions

`hello@eidan.dev`
