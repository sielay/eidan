// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable, encrypted-at-rest secrets for the matbot-era deploy (the matbot replacement for the old
// ansible-vault plan — there is no ansible in the current deploy path).
//
// The canonical secret set lives in a gitignored plaintext `.env` that, per the deploy docs, "exists
// only in that one checkout" — lose the laptop, lose the config. `seal` encrypts `.env` -> `.env.enc`,
// which IS committable to the PRIVATE canary repo (like sops / ansible-vault): the secrets are durably
// tracked without any plaintext in git history. `open` restores `.env` from `.env.enc` on a fresh
// checkout. The passphrase comes from `.vault-pass` (gitignored, 0600) or $EIDAN_VAULT_PASS — never a
// CLI argument, never printed. AES-256-CBC + PBKDF2 (200k iters) via openssl.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import { ROOT } from "./assemble.mjs";

const PLAIN = join(ROOT, ".env");
const SEALED = join(ROOT, ".env.enc");
const PASS_FILE = join(ROOT, ".vault-pass");
const ENC_ARGS = ["enc", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-salt"];

// Resolve the passphrase without ever exposing it on a command line. Refuse a group/other-readable
// pass file (it would defeat the point). Passed to openssl via `-pass env:` in a child env only.
export function passphrase() {
  if (process.env.EIDAN_VAULT_PASS) return process.env.EIDAN_VAULT_PASS;
  if (existsSync(PASS_FILE)) {
    if (statSync(PASS_FILE).mode & 0o077) {
      throw new Error(".vault-pass is group/other-readable — `chmod 0600 .vault-pass`");
    }
    const p = readFileSync(PASS_FILE, "utf8").trim();
    if (!p) throw new Error(".vault-pass is empty");
    return p;
  }
  throw new Error("no passphrase: set $EIDAN_VAULT_PASS or create .vault-pass (chmod 0600)");
}

function opensslFile(args, pass) {
  execFileSync("openssl", args, { env: { ...process.env, __VP: pass }, stdio: ["ignore", "ignore", "inherit"] });
}

// Decrypt SEALED to a buffer in memory (for status/diff) without writing plaintext to disk.
function decryptToBuffer(pass) {
  return execFileSync("openssl", [...ENC_ARGS, "-d", "-in", SEALED, "-pass", "env:__VP"],
    { env: { ...process.env, __VP: pass }, encoding: "buffer" });
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

export function seal() {
  if (!existsSync(PLAIN)) throw new Error(`${PLAIN} not found — nothing to seal`);
  const pass = passphrase();
  opensslFile([...ENC_ARGS, "-in", PLAIN, "-out", SEALED, "-pass", "env:__VP"], pass);
  console.log(`✓ sealed .env -> .env.enc (${sha(readFileSync(PLAIN)).slice(0, 12)}…). Commit .env.enc; keep .env + .vault-pass out of git.`);
}

export function open(force = false) {
  if (!existsSync(SEALED)) throw new Error(`${SEALED} not found — nothing to open`);
  if (existsSync(PLAIN) && !force) {
    throw new Error(".env already exists — refusing to overwrite. Re-run with --force to replace it.");
  }
  const pass = passphrase();
  opensslFile([...ENC_ARGS, "-d", "-in", SEALED, "-out", PLAIN, "-pass", "env:__VP"], pass);
  console.log("✓ opened .env.enc -> .env");
}

// Report presence + whether .env matches what's sealed, WITHOUT printing any secret value.
export function status() {
  const hasPlain = existsSync(PLAIN);
  const hasSealed = existsSync(SEALED);
  console.log(`.env:     ${hasPlain ? "present" : "MISSING"}`);
  console.log(`.env.enc: ${hasSealed ? "present" : "MISSING"}`);
  if (hasPlain && hasSealed) {
    try {
      const same = sha(readFileSync(PLAIN)) === sha(decryptToBuffer(passphrase()));
      console.log(same ? "✓ .env.enc is in sync with .env" : "⚠ .env has changes not yet sealed (run `secrets seal`)");
    } catch (e) {
      console.log(`(could not compare: ${e.message.split("\n")[0]})`);
    }
  }
}

// Self-test the round-trip on throwaway data + passphrase (no real secrets touched). For CI/dev.
export function selftest() {
  const dir = mkdtempSync(join(tmpdir(), "eidan-secrets-"));
  const f = join(dir, "plain"), e = join(dir, "enc");
  const sample = "FOO=bar\nKEK=do-not-log\n";
  writeFileSync(f, sample);
  const env = { ...process.env, __VP: "throwaway-test-pass" };
  execFileSync("openssl", [...ENC_ARGS, "-in", f, "-out", e, "-pass", "env:__VP"], { env });
  const back = execFileSync("openssl", [...ENC_ARGS, "-d", "-in", e, "-pass", "env:__VP"], { env, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  if (back !== sample) throw new Error("secrets self-test FAILED: round-trip mismatch");
  console.log("✓ secrets self-test passed (seal/open round-trips; values never printed)");
}
