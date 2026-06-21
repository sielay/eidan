# @eidandev/charles-decks

**Deck rendering** for the Charles bundle (charles#8). A matbot
plugin registering one flagship tool, `render_deck`: the agent composes
Marp markdown (slides + house style), this renders it deterministically
into editable **pptx / html / pdf**, stores each format via matbot's
`FileStore`, and emits a `file` event per format so it surfaces as a
download chip on the message.

Ported from the Python `eidan_decks` plugin onto the matbot runtime.

## How it works

- `src/render.ts` — the deterministic mechanic. Shells out to the `marp`
  CLI (`@marp-team/marp-cli`); injectable/mappable for tests. HTML needs
  only Node; **pptx/pdf additionally need headless Chromium** on the host.
- `src/tools.ts` — the `render_deck` tool. Renders, then `ctx.files.put`s
  each format (owned by the turn's principal) with `allowed: true` so it
  is servable, and yields a `{type:'file', handle}` event per format.
- `src/index.ts` — the `MatbotPluginSpec`. Stateless: the FileStore is
  resolved per-call from `ctx.files`, so a host without one gets a clean
  error at call time instead of blocking activation.

## Config

- `EIDAN_MARP_BIN` — marp CLI binary (default `marp`).
- `EIDAN_MARP_TIMEOUT_S` — per-format render timeout (default `120`).
