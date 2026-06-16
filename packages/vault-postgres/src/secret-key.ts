// SPDX-License-Identifier: AGPL-3.0-or-later
// `scope.subkey` namespacing for vault keys — the single source of truth shared by the read path
// and the write tool, so a value set under a key is always found by the same key (mirrors the
// Python `split_secret_key`). A flat env-style name like `EIDAN_IMAP_PASSWORD` (no dot) lands in
// scope `core`; `slack.bot_token` -> scope `slack`, subkey `bot_token`. Pure (no pg), so it is
// unit-testable in isolation. See docs/0009-secrets-vault.md.

export function splitSecretKey(key: string): { scope: string; subkey: string } {
  const dot = key.indexOf('.');
  if (dot === -1) return { scope: 'core', subkey: key };
  return { scope: key.slice(0, dot), subkey: key.slice(dot + 1) };
}
