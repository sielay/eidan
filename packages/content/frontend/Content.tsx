// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Content workflow home. Three parts: the brand kit (grounds every generation), the shipped workflow
// overview, and the campaign board (reuses the shared BoardsPanel, scoped to "content"). The
// generative steps run in chat via the content tools (content_workflow / brand_kit / image_generate);
// this panel is where you set the brand and track campaigns as cards.
import * as React from "react";

import { authFetch } from "@/lib/auth";
import { BoardsPanel } from "@/plugins/_shared/BoardsPanel";

interface Brand { voice: string | null; styleguide: string | null; language: string | null }

// Mirror of the shipped linkedin-carousel workflow (packages/content/src/workflows) for display. The
// engine is the source of truth; this is a static overview.
const WORKFLOW = {
  label: "LinkedIn carousel",
  stages: [
    ["Concept", "Shape the hook + slide outline (iterate until it lands)"],
    ["Assets", "Draft per-slide image prompts, then generate the slides"],
    ["Copy", "Write the post copy, grounded in the concept + slides"],
    ["Review", "Approve, then hand to scheduling"],
  ] as Array<[string, string]>,
};

function BrandKit(): React.ReactElement {
  const [brand, setBrand] = React.useState<Brand>({ voice: "", styleguide: "", language: "" });
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        const r = await authFetch("/api/content/brand");
        const j = (await r.json()) as { brand?: Brand };
        if (j.brand) setBrand({ voice: j.brand.voice ?? "", styleguide: j.brand.styleguide ?? "", language: j.brand.language ?? "" });
      } catch { /* leave blank */ }
    })();
  }, []);

  const save = React.useCallback(async () => {
    setSaving(true); setStatus(null);
    try {
      const r = await authFetch("/api/content/brand", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(brand),
      });
      setStatus(r.ok ? "Brand kit saved." : "Could not save.");
    } catch { setStatus("Could not save."); } finally { setSaving(false); }
  }, [brand]);

  const field = (label: string, key: keyof Brand, ph: string) => (
    <label style={{ display: "block", marginTop: "var(--s3)" }}>
      <span style={{ display: "block", fontSize: "var(--fs-13)", color: "var(--muted)", marginBottom: "var(--s1)" }}>{label}</span>
      <textarea
        value={brand[key] ?? ""}
        onChange={(e) => setBrand((b) => ({ ...b, [key]: e.target.value }))}
        placeholder={ph}
        rows={3}
        style={{ width: "100%", boxSizing: "border-box", padding: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface)", color: "var(--text)", font: "inherit", resize: "vertical" }}
      />
    </label>
  );

  return (
    <section style={{ marginTop: "var(--s5)" }}>
      <h3 style={{ fontSize: "var(--fs-17)", margin: 0 }}>Brand kit</h3>
      <p style={{ margin: "var(--s1) 0 0", color: "var(--muted)", fontSize: "var(--fs-13)" }}>
        Layered into every generation so content stays on-brand. The agent reads it too (via the <code>brand_kit</code> tool).
      </p>
      {field("Voice & tone", "voice", "e.g. warm, plain-spoken, a bit contrarian; no jargon")}
      {field("Visual style", "styleguide", "e.g. bold sans headline, off-white bg, one accent colour, generous space")}
      {field("Language rules", "language", "e.g. British English; say 'agent' not 'bot'; never hype")}
      <div style={{ marginTop: "var(--s2)", display: "flex", alignItems: "center", gap: "var(--s3)" }}>
        <button className="btn-accent" onClick={() => void save()} disabled={saving} style={{ padding: "var(--s2) var(--s3)", borderRadius: "var(--r-sm)", border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--accent-contrast)", cursor: "pointer" }}>
          {saving ? "Saving…" : "Save brand kit"}
        </button>
        {status && <span style={{ fontSize: "var(--fs-13)", color: "var(--muted)" }}>{status}</span>}
      </div>
    </section>
  );
}

function WorkflowOverview(): React.ReactElement {
  return (
    <section style={{ marginTop: "var(--s6)" }}>
      <h3 style={{ fontSize: "var(--fs-17)", margin: 0 }}>Workflow — {WORKFLOW.label}</h3>
      <p style={{ margin: "var(--s1) 0 var(--s3)", color: "var(--muted)", fontSize: "var(--fs-13)" }}>
        A shipped, staged flow. Each column is a step; you approve to advance. Work a step in chat: open a card, then say
        “work on this card” — the agent pulls the stage prompt (<code>content_workflow</code>), generates slides
        (<code>image_generate</code>), and links them back.
      </p>
      <ol style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)", listStyle: "none", padding: 0, margin: 0 }}>
        {WORKFLOW.stages.map(([name, desc], i) => (
          <li key={name} style={{ flex: "1 1 180px", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "var(--s3)", background: "var(--surface)" }}>
            <div style={{ fontFamily: "var(--font-num)", fontSize: "var(--fs-13)", color: "var(--muted)" }}>Step {i + 1}</div>
            <div style={{ fontWeight: 600, marginTop: 2 }}>{name}</div>
            <div style={{ fontSize: "var(--fs-13)", color: "var(--muted)", marginTop: 2 }}>{desc}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function Content(): React.ReactElement {
  return (
    <div style={{ padding: "var(--s5)", maxWidth: 980, margin: "0 auto" }}>
      <h2 style={{ fontSize: "var(--fs-20)", margin: 0 }}>Content</h2>
      <p className="screen-sub" style={{ marginTop: 0, color: "var(--muted)" }}>
        Plan campaigns as cards, ground them in your brand kit, and let the agent generate the assets and copy — nothing
        lost in chat.
      </p>

      <BrandKit />
      <WorkflowOverview />

      <section style={{ marginTop: "var(--s6)" }}>
        <h3 style={{ fontSize: "var(--fs-17)", margin: "0 0 var(--s2)" }}>Campaigns</h3>
        <BoardsPanel scopeKind="content" basePath="/p/content" />
      </section>
    </div>
  );
}
