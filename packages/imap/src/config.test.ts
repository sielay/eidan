// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { imapPassKey, pickAccount, slugify, smtpPassKey } from "./config.js";
import type { AccountRow } from "./db.js";

function row(name: string, slug: string): AccountRow {
  return {
    id: name,
    name,
    slug,
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_user: `${slug}@example.com`,
    imap_pass_key: imapPassKey(slug),
    smtp_host: "smtp.example.com",
    smtp_port: 587,
    smtp_user: `${slug}@example.com`,
    smtp_pass_key: smtpPassKey(slug),
    smtp_from: "",
  };
}

describe("slugify", () => {
  it("lowercases, collapses non-alphanumerics, and trims underscores", () => {
    assert.equal(slugify("Work Mail"), "work_mail");
    assert.equal(slugify("  My-Personal!!Box  "), "my_personal_box");
  });

  it("falls back to a default for empty/punctuation-only names", () => {
    assert.equal(slugify(""), "account");
    assert.equal(slugify("!!!"), "account");
  });
});

describe("pass key derivation", () => {
  it("namespaces IMAP and SMTP keys by slug and keeps them distinct", () => {
    assert.equal(imapPassKey("work"), "EIDAN_IMAP_PASS_work");
    assert.equal(smtpPassKey("work"), "EIDAN_SMTP_PASS_work");
    assert.notEqual(imapPassKey("work"), smtpPassKey("work"));
  });
});

describe("pickAccount", () => {
  const rows = [row("Work", "work"), row("Personal", "personal")];

  it("returns undefined when there are no accounts", () => {
    assert.equal(pickAccount([], undefined), undefined);
    assert.equal(pickAccount([], "work"), undefined);
  });

  it("defaults to the first (oldest) account when none is named", () => {
    assert.equal(pickAccount(rows, undefined)?.slug, "work");
    assert.equal(pickAccount(rows, "")?.slug, "work");
  });

  it("matches by exact name (case-insensitive)", () => {
    assert.equal(pickAccount(rows, "personal")?.slug, "personal");
    assert.equal(pickAccount(rows, "PERSONAL")?.slug, "personal");
  });

  it("matches by slugified name", () => {
    assert.equal(pickAccount(rows, "Work")?.slug, "work");
  });

  it("returns undefined for an unknown account name", () => {
    assert.equal(pickAccount(rows, "archive"), undefined);
  });
});
