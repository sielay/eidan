<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0006 — Native app wrapper (Capacitor)

Status: **Shipped (Android verified on device)** — `apps/mobile` is a Capacitor 8 shell that
ships the `apps/web` front door as an installable iOS / Android app. Android builds to a real
APK and runs on a physical device against a live host; the iOS project generates (SPM) and is
ready to build in Xcode.

## Goal

Put eidan in the App Store / Play Store and on the home screen as a real native app, with
access to native capabilities (push, share, status bar, splash) — without re-implementing the
UI. The web front door is the entire product surface; the wrapper is a thin native container
around it. Builds on the PWA (see `0003-pwa-installable-web-app.md`).

## Why a remote `server.url`, not a bundled static app

`apps/web` is a **server-rendered** Next.js app (`output: "standalone"`) — proxy routes for
chat/auth plus Next→Postgres dashboards. It is **not** a static export, so there is no static
bundle to embed in the binary. The shell therefore loads the front door over the network from
Capacitor's `server.url`. A nice consequence: **UI/web changes ship server-side and reach the
app with no rebuild** — only `capacitor.config.ts`, the plugin set, or the native projects
need a rebuild.

## Self-hosted ⇒ the host is never hardcoded

eidan is self-hosted, so the wrapper can't bake in a server URL — every operator points it at
**their own** instance. `capacitor.config.ts` reads it from the environment at `cap sync`
time and never commits it (gitignored-config policy):

```
EIDAN_MOBILE_SERVER_URL=https://your-host pnpm --filter @eidandev/mobile sync
```

With no URL set, the app loads the bundled `public/index.html` fallback. Overrides:
`EIDAN_MOBILE_APP_ID` / `_APP_NAME` (store identity), `EIDAN_MOBILE_ALLOW_CLEARTEXT=1` (LAN/dev
http host only).

## The pieces

| Piece | File | Role |
|---|---|---|
| Config | `apps/mobile/capacitor.config.ts` | env-driven `server.url`, brand splash/colours, plugins |
| Icon pipeline | `apps/mobile/scripts/gen-icons.mjs` | rasterises the glyph → native `assets/*.png` **and** the PWA's PNG icons |
| Fallback shell | `apps/mobile/public/index.html` | cold-start splash / "configure a host" page |
| Native projects | `apps/mobile/{ios,android}/` | **generated** (`cap add`), **gitignored** — re-creatable any time |

Capacitor **8**; native plugins: `@capacitor/app`, `@capacitor/status-bar`,
`@capacitor/splash-screen`. The native projects are gitignored because they're
operator-specific (bundle id, signing) and regenerable from config.

## Build & run

Full runbook in `apps/mobile/README.md`. Key gotchas:

- **Android needs JDK 21** (Capacitor 8); Java 17 fails `invalid source release: 21`. Use
  Android Studio's bundled JBR. `:app:assembleDebug` produces a real APK.
- **iOS uses Swift Package Manager** — no CocoaPods needed for `cap add ios`.
- **Icons:** `scripts/gen-icons.mjs` (via the `sharp` inside `@capacitor/assets`, no system
  rasteriser) then `pnpm assets` fans out to both platforms.
- **Deploy to a device:** Android over USB (`adb install` the APK) or wirelessly; iOS via Xcode
  with a signing team (one cable the first time, or TestFlight for fully-wireless).

## Authentication in the native shell

Magic-link sign-in needs care inside a wrapped WebView. Tapping the emailed link opens it in a
**different** browser (e.g. Gmail's Custom Tab), which sets the session cookie in **that**
browser's jar — the app's WebView never sees it, so the user appears logged out. The link-based
flow only works when the click lands back in the same WebView.

**Fix (shipped):** the magic-link email already carries a 6-digit code, and the login screen now
leads with a **code-entry field** (`apps/web` login) that verifies in the app's own WebView
context, so the session lands in the right jar. This is the reliable native-app pattern; the
emailed link stays as a same-browser fallback.

**Future polish (Option B — App Links / Universal Links):** make the emailed link open *in the
app*. This is operator-specific (the `assetlinks.json` / AASA must carry the app's signing
fingerprint and the operator's host), so it lives in the deploy repo, not public core — see the
README. The code path already solves login, so App Links is pure UX polish.

## Files of record

- `apps/mobile/` — `capacitor.config.ts`, `package.json`, `scripts/gen-icons.mjs`, `assets/`,
  `public/index.html`, `README.md`
- `apps/web/src/app/(auth)/login/page.tsx` — code-entry login
- `apps/web/src/app/manifest.ts`, `apps/web/public/icons/*` — shared PNG icons (see `0003`)

## Open items

- Native push → `@eidandev/notify` (`@capacitor/push-notifications` + APNs/FCM transport).
- App Links / Universal Links (Option B above).
- Strategy-B "first-run URL entry" so one published app serves every self-hoster (vs the current
  build-time `EIDAN_MOBILE_SERVER_URL`).
- iOS device/TestFlight build (project generates; not yet run through signing).
