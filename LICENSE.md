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

## Plugins are AGPL too

Every eidan plugin — including the mail, calendar, Gmail, and Drive
integrations — lives in this repo (or another AGPL repo) and ships
under AGPL. There are no proprietary or paid plugins. A plugin links
into core through the `@eidandev/*` packages and matbot's service
registry, which makes it a derivative work, so it must be released
under AGPL-compatible terms when distributed.

## Contributor License Agreement (CLA)

Sielay Ltd owns the copyright on core and stewards its licence.
Outside contributions require a signed **CLA** so that licence can be
kept consistent and, if ever needed, updated to a later AGPL version
(or another OSI-approved open-source licence) as the ecosystem
evolves. The CLA does **not** transfer your copyright, change AGPL for
anyone else, or permit relicensing core out of open source — Sielay
Ltd has committed to that in [`CLA.md §7`](CLA.md). See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Questions

`hello@eidan.dev`
