<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @eidandev/mobile — Capacitor native shell (seed)

A thin [Capacitor](https://capacitorjs.com/) wrapper that ships the Eidan web front
door (`apps/web`) as an installable iOS / Android app. This is a **seed/scaffold**, not a
finished native app — the config and runbook are in the repo; the platform-specific native
projects (`ios/`, `android/`) must be generated on a machine that has the native toolchains
(they are intentionally **not** committed — see [.gitignore](#native-artifacts-are-gitignored)).

## Why this layout (`apps/mobile/`)

- `apps/web` is the existing front door; a sibling `apps/mobile` keeps the two "apps"
  together under the workspace's `apps/*` umbrella, parallel to how `packages/*` holds
  plugins. The mobile shell is a *consumer* of the web app, not a plugin, so it belongs in
  `apps/`, not `packages/`.
- A root-level `capacitor.config.ts` was rejected: it would pollute the repo root and imply
  the whole monorepo is a Capacitor project. Scoping everything under `apps/mobile/` keeps
  the blast radius small and the root clean.

## Why a configurable `server.url`, not bundled static assets

`apps/web` is a **server-rendered** Next.js app (`output: "standalone"`) — it is not a static
export, so there is no static bundle to embed in the binary. The shell therefore loads the
front door over the network from a **configurable URL**:

```
EIDAN_MOBILE_SERVER_URL=https://your-eidan-host pnpm --filter @eidandev/mobile sync
```

The URL is read from the environment in `capacitor.config.ts` and is **never hardcoded** to
any operator host (matches `apps/web`'s `NEXT_PUBLIC_EIDAN_BACKEND_URL` convention and the
repo's gitignored-config policy). When `EIDAN_MOBILE_SERVER_URL` is unset, the shell falls
back to the minimal `public/index.html` placeholder so `cap sync` still succeeds.

> If the web app is later given a static export target (`output: "export"`), the shell could
> instead bundle those assets by pointing `webDir` at the export output and dropping
> `server.url`. That is a future option, not the current path.

## Prerequisites

- **Node + pnpm** (repo pins `pnpm@9.15.9`).
- **iOS:** macOS, Xcode (+ command-line tools), CocoaPods (`sudo gem install cocoapods` or
  `brew install cocoapods`).
- **Android:** Android Studio (SDK + platform-tools), a JDK (17+).

## Runbook — generating and running the native projects

These commands were **not** run by the seed (the scaffolding sandbox has no native toolchain
and blocks the `cap add` step). Run them on a dev machine:

```bash
# 0. Install workspace deps (from repo root)
pnpm install

# 1. Configure the host the app should load (do NOT commit this)
cp apps/mobile/.env.example apps/mobile/.env
# edit apps/mobile/.env -> set EIDAN_MOBILE_SERVER_URL=https://your-host
set -a && . apps/mobile/.env && set +a       # export the vars for the cap CLI

# 2. Scaffold the native projects (creates apps/mobile/ios and apps/mobile/android)
pnpm --filter @eidandev/mobile add:ios        # macOS + Xcode only
pnpm --filter @eidandev/mobile add:android

# 3. Sync config + web assets into the native projects
pnpm --filter @eidandev/mobile sync           # runs `cap sync`

# 4. Open in the native IDE to build/run on a simulator or device
pnpm --filter @eidandev/mobile open:ios
pnpm --filter @eidandev/mobile open:android
```

Re-run `cap sync` after any change to `capacitor.config.ts`, `EIDAN_MOBILE_SERVER_URL`, or
the plugin set.

### What is scaffolded vs TODO

| Item | Status |
|---|---|
| `capacitor.config.ts` (env-driven server URL) | Done (in repo) |
| `package.json` + scripts (`add:ios/android`, `sync`, `open:*`) | Done |
| `tsconfig.json`, `.env.example`, `public/` fallback page | Done |
| `.gitignore` entries for native build artifacts | Done |
| `ios/` native project | **TODO — run `cap add ios` on macOS/Xcode** |
| `android/` native project | **TODO — run `cap add android`** |
| `pnpm install` to resolve `@capacitor/*` deps | **TODO — run on a dev machine** |
| Health Connect / HealthKit plugin wiring | **Design only** — see `docs/0001-health-connect-healthkit-design.md` |

## Native artifacts are gitignored

CocoaPods, Gradle caches, Xcode `DerivedData`, and build outputs are **not** committed. See the
repo-root `.gitignore` (`apps/mobile/ios/`, `apps/mobile/android/` build/cache paths) and
`apps/mobile/.gitignore`. The generated native projects can be re-created at any time from
this config with `cap add` + `cap sync`, so the seed deliberately tracks only the config.

## Not wired into CI

Native builds are intentionally **not** part of the default CI. The only CI-relevant script
here is `typecheck`. Building `ios/`/`android/` requires the native toolchains and is a
manual / dedicated-pipeline step.
