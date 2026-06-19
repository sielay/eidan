<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0001 — Health Connect / HealthKit integration (design)

Status: **Design / groundwork** (no production code yet — paired with the `apps/mobile`
Capacitor seed). This document is the plan for importing device health data into eidan via
the native shell. A minimal POC stub is described at the end but is explicitly optional.

## Goal

Let the native shell (`apps/mobile`) read a user's on-device health data — **Health Connect**
on Android, **HealthKit** on iOS — and flow it into eidan as canonical, queryable memory the
agent can reason over ("how did I sleep this week", "am I hitting my step goal", "summarise my
workouts"). Health data is sensitive; the design is privacy-first and opt-in per data type.

## Plugin choice (Capacitor)

The Capacitor ecosystem has a few community health plugins. The leading candidates:

| Plugin | Android | iOS | Notes |
|---|---|---|---|
| **`@capacitor-community/health-connect`** | Health Connect | — | Android-only; modern Health Connect API (the Google-blessed successor to Google Fit). |
| **`capacitor-health`** (mahnuh / community forks) | Health Connect | HealthKit | Single plugin spanning both platforms; smaller surface, fewer data types. |
| **`@perfood/capacitor-healthkit`** | — | HealthKit | iOS-only; mature HealthKit read access. |

**Recommendation:** start with a **single cross-platform plugin** (`capacitor-health`-style)
for the first data types to keep one permission/read API, and fall back to the
platform-specific plugins (`@capacitor-community/health-connect` + `@perfood/capacitor-healthkit`)
only if a needed data type or granularity is missing. The exact package is an **operator/maintainer
decision** to be locked when the integration is built — pin a specific version and audit it (these
are community plugins touching sensitive permissions).

> Health Connect requires Android 14+ natively (or the standalone Health Connect app on
> Android 8–13). HealthKit requires a physical iOS device for most data (the simulator has no
> health data) and an Apple Developer entitlement.

## Permissions model

Both platforms gate health data behind **per-data-type, user-granted permissions**, requested at
runtime — never silently. Design rules:

- **Opt-in per type.** Request only the types the user enables in eidan's settings, one scope at a
  time, with a clear in-app explanation *before* the native prompt.
- **Read-only first.** The first iteration requests **read** scopes only. Write-back (e.g. logging a
  workout from eidan) is out of scope for the seed.
- **Declare scopes statically.** iOS needs `NSHealthShareUsageDescription` (and
  `NSHealthUpdateUsageDescription` if writing) in `Info.plist`; Android needs Health Connect
  permission declarations in the manifest plus a privacy-policy intent filter. These land in the
  generated native projects (`apps/mobile/ios`, `apps/mobile/android`) at integration time.
- **Revocation-aware.** Treat permission as revocable at any time; every read path must handle
  "permission not granted / revoked" without crashing and surface a re-request affordance.
- **iOS authorization opacity.** HealthKit deliberately does **not** reveal whether *read* access
  was denied (to avoid leaking that the user has no data) — code must treat an empty result as
  indistinguishable from "denied" and not loop on prompts.

## First data types to import

Start narrow, in this order (highest value / simplest shape first):

1. **Steps** — daily/period step counts (cumulative quantity).
2. **Sleep** — sleep sessions / stages.
3. **Workouts** — activity sessions (type, duration, energy).
4. **Heart rate** — sampled bpm series (highest volume; import summarised, not every sample).

For each: import as time-bounded samples with `start`/`end`, a typed value + unit, and the source
device/app. Heart rate especially must be **down-sampled / summarised** on import (min/avg/max per
window) rather than persisting raw high-frequency series.

## How the data flows into eidan

```
device sensors
   │   (Health Connect / HealthKit, on-device)
   ▼
Capacitor health plugin  ── in apps/mobile (native shell)
   │   read(scope, range) -> normalised samples
   ▼
sync client (in the web front door / shell)
   │   POST canonical samples (snake_case, deduped by (source, type, start, end))
   ▼
@eidandev/health  ── FUTURE core plugin (packages/health)
   │   • exposes an EidanHealth service via the service registry
   │   • owns a plugin-private `plugin_health` schema (per the plugin-private-schema rule)
   │   • writes a CANONICAL STORE of health samples (append-only, soft-delete,
   │     created_at/updated_at, partial indexes — matches core memory conventions)
   ▼
eidan memory / agent
   • the agent queries the canonical store via EidanHealth tools (recall steps/sleep/etc.)
   • higher-level rollups (weekly summaries) can be materialised as notes/knowledge
```

Key design points:

- **A future `@eidandev/health` plugin** is the core landing point — one matbot plugin exporting
  `const plugin`, registering an `EidanHealth` service, owning a `plugin_health` schema. It is the
  ingestion API the shell posts to and the query API the agent reads from. It does **not** exist
  yet; this doc is its spec.
- **Canonical store.** Health samples land in a single canonical, normalised store keyed by
  `(source, data_type, start_ts, end_ts)` for idempotent dedupe. Richer health *features*
  (insights, goals, coaching) build on top as additional plugins; the core plugin owns the
  canonical store + ingestion. (Feature plugins may live here or in their own AGPL repo.)
- **snake_case on the wire and in Postgres**, append-only rows, soft-delete via `deleted_at`,
  per the repo conventions.
- **Ingestion is keen + idempotent.** Re-syncing a window must not duplicate rows.

## iOS / Android divergence

| Concern | iOS (HealthKit) | Android (Health Connect) |
|---|---|---|
| API | HealthKit, per-type quantity/category/workout samples | Health Connect records (Steps, SleepSession, ExerciseSession, HeartRate) |
| Min platform | Real device; Developer entitlement | Android 14+ native, or Health Connect app on 8–13 |
| Permission UX | Combined auth sheet; read-denial is opaque | Per-permission grants; revocable in Health Connect app |
| Manifest/decl | `Info.plist` usage strings + Health entitlement | Manifest permissions + privacy-policy intent filter |
| Background read | Background delivery available (extra entitlement) | Background read is restricted; foreground sync first |
| Data model quirks | Sleep as category samples; energy in kcal | Sleep as session+stages; explicit units per record |

Implication: keep a **thin platform-specific read layer** that normalises into one canonical sample
shape, so everything above the plugin boundary is platform-agnostic. Sleep is the type most likely
to need per-platform mapping.

## Optional POC stub (not built here)

A minimal proof-of-concept, if/when someone picks this up, would be:

1. Add the chosen health plugin to `apps/mobile`.
2. A single "Connect Health" button that requests **steps read** only.
3. Read the last 7 days of steps and `console.log` / show them in the shell — no persistence yet.
4. Only once that works end-to-end on a real device, build `@eidandev/health` + the canonical
   schema migration (`migrations/sql/NNNN_health.sql`) and wire the sync POST.

This staged approach validates the fragile part (native permissions + reads on a real device)
before any schema or core-plugin work.

## Open operator decisions

- **Exact plugin + version** to pin and audit (cross-platform vs the two platform-specific plugins).
- **App identifiers / entitlements** (`appId`, Apple Health entitlement, Android privacy-policy URL).
- **Retention policy** for raw vs summarised heart-rate data.
- **Where richer health features live** — confirmed direction: canonical store in core
  (`@eidandev/health`), richer features as additional plugins on top.
