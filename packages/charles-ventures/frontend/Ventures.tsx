// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Charles · Ventures — the multi-venture spine screen (brief §7 Charles, design "VenturesFull").
// Surface B (deterministic): reads/writes plugin_ventures.* over the bundle's own data routes
// (GET/POST /api/charles/ventures, POST .../lookup) — the Next-reads-Postgres pattern, a faithful
// recreation of the Claude Design mock. Uses the core design system (tokens + .card/.stat/.pill/
// .loglist/.scope/.grid-2/.empty/.screen-sub/.sheet/.field/.seg from globals.css) + the bundle's
// charles.css for the screen-specific bits. Cross-plugin figures (cash / pipeline) come from
// Books/CRM and surface only once those bundles are connected — until then the screen shows what
// Ventures actually owns, no fake numbers.
//
// Refinements over the base screen: the resource-attach bottom sheet (brief §7 "Resource-attach
// sheet"), a desktop identity context panel with a Companies House lookup affordance (the
// venture_lookup_company tool, surfaced in the UI), and a responsive two-pane layout (brief §4/§8).

import * as React from "react";

import { authFetch } from "@/lib/auth";

interface Venture {
  id: string;
  parent_id: string | null;
  parent_name?: string | null;
  name: string;
  kind: string;
  legal_type: string | null;
  status: string;
  identity?: Record<string, unknown> | null;
}
interface Resource {
  id: string;
  kind: string;
  provider: string;
  external_ref: string;
  label: string | null;
  status: string;
}
interface VenturesPayload {
  ventures: Venture[];
  current: (Venture & { identity: Record<string, unknown> | null }) | null;
  resources: Resource[];
}

type Tone = "good" | "info" | "warn" | "alert" | "neutral";

// ── tiny icon set (only what this screen uses) ──────────────────────────────
const ICONS: Record<string, React.ReactNode> = {
  ventures: <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" />,
  bank: <path d="M3 10l9-6 9 6M5 10v9m14-9v9M3 21h18M9 14v3m6-3v3" />,
  link: <path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1m-3 8a5 5 0 01-7 0l-2-2a5 5 0 017-7l1 1" />,
  mail: <path d="M3 6h18v12H3zM3 7l9 6 9-6" />,
  social: <path d="M18 8a3 3 0 10-3-3M6 13a3 3 0 100 6 3 3 0 000-6zm12 5a3 3 0 10-3-3M8.6 14.5l6.8 3M15.4 6.5l-6.8 4" />,
  analytics: <path d="M4 20V10m6 10V4m6 16v-7m-12 7h12" />,
  check: <path d="M5 12l5 5 9-11" />,
  add: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  search: <path d="M11 19a8 8 0 100-16 8 8 0 000 16zm10 2l-4.3-4.3" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
};

function Icon({ name, cls = "i i-sm" }: { name: string; cls?: string }): React.ReactElement {
  return (
    <svg className={cls} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name] ?? ICONS["link"]}
    </svg>
  );
}

function ScreenHead({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }): React.ReactElement {
  return (
    <div className="screen-head" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--s3)", marginBottom: "var(--s4)" }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: "var(--fs-24)" }}>{title}</h1>
        {sub ? <p className="screen-sub">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

function StatTile({ label, value, foot }: { label: string; value: React.ReactNode; foot?: React.ReactNode }): React.ReactElement {
  return (
    <div className="card">
      <div className="stat">
        <span className="stat__label">{label}</span>
        <span className="stat__value num" style={{ fontSize: "var(--fs-24)" }}>{value}</span>
        {foot}
      </div>
    </div>
  );
}

function Empty({ icon, title, body, cta, onCta }: { icon: string; title: string; body: string; cta: string; onCta?: () => void }): React.ReactElement {
  return (
    <div className="empty">
      <span className="empty__icon"><Icon name={icon} cls="i" /></span>
      <div className="empty__title">{title}</div>
      <div className="empty__body">{body}</div>
      <button className="btn btn--primary" onClick={onCta}>{cta}</button>
    </div>
  );
}

function Skeleton(): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
      <div className="grid-2">
        <div className="skel" style={{ height: 96 }} />
        <div className="skel" style={{ height: 96 }} />
      </div>
      <div className="skel" style={{ height: 220 }} />
    </div>
  );
}

// resource kind → icon + human label
const RES_META: Record<string, { icon: string; label: string }> = {
  social_account: { icon: "social", label: "Social account" },
  mailing_list: { icon: "mail", label: "Mailing list" },
  analytics_property: { icon: "analytics", label: "Analytics property" },
};
const RES_KINDS = Object.keys(RES_META);
function resTone(status: string): Tone {
  return status === "active" ? "good" : "neutral";
}
function ident(o: Record<string, unknown> | null | undefined, k: string): string | null {
  const v = o?.[k];
  return typeof v === "string" && v.length ? v : null;
}

// Order the flat venture list into a parents-before-children tree and tag each with its depth, so
// the dropdown (and any other list) can indent children under their parent. The GET already returns
// parents-before-children, but we re-derive structurally here so depth is correct even for grand-
// children and so an orphan (a child whose parent isn't in the visible set) still shows at top level.
interface TreeNode { v: Venture; depth: number }
function ventureTree(ventures: Venture[]): TreeNode[] {
  const byParent = new Map<string | null, Venture[]>();
  const ids = new Set(ventures.map((v) => v.id));
  for (const v of ventures) {
    // treat a child whose parent is missing from the set as top-level, so nothing disappears
    const key = v.parent_id && ids.has(v.parent_id) ? v.parent_id : null;
    const list = byParent.get(key);
    if (list) list.push(v);
    else byParent.set(key, [v]);
  }
  const out: TreeNode[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const v of byParent.get(parentId) ?? []) {
      out.push({ v, depth });
      walk(v.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function ScopeSwitcher({ ventures, currentId, onPick, onAdd }: { ventures: Venture[]; currentId: string | null; onPick: (id: string) => void; onAdd: () => void }): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  if (!ventures.length) return null;
  const current = ventures.find((v) => v.id === currentId) ?? ventures[0];
  const tree = ventureTree(ventures);
  return (
    <div className="scope-wrap">
      <button className="scope" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="ventures" />
        <span className="scope__name">{current?.name}</span>
        <svg className="i i-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ transform: open ? "rotate(180deg)" : "", transition: "transform var(--dur-1) var(--ease)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <>
          <div className="scope__scrim" onClick={() => setOpen(false)} />
          <div className="scope__menu">
            <div className="scope__holding"><Icon name="bank" />Ventures<span className="scope__count num">{ventures.length}</span></div>
            {tree.map(({ v, depth }) => (
              <button key={v.id} className={"scope__item" + (v.id === current?.id ? " is-active" : "")} style={depth > 0 ? { paddingLeft: `calc(var(--s3) + ${depth} * var(--s4))` } : undefined} onClick={() => { onPick(v.id); setOpen(false); }}>
                <span className="scope__item-main">
                  <span className="scope__item-name">{depth > 0 ? <span style={{ color: "var(--faint)" }} aria-hidden="true">↳ </span> : null}{v.name}</span>
                  <span className="scope__item-kind">{v.legal_type ? v.legal_type + " · " : ""}{v.kind}</span>
                </span>
                {v.id === current?.id ? <Icon name="check" cls="i i-sm scope__check" /> : null}
              </button>
            ))}
            <button className="scope__add" onClick={() => { setOpen(false); onAdd(); }}><Icon name="add" />Add venture</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Identity panel (desktop aside / mobile card) ─────────────────────────────
function IdentityPanel({ venture, onLinked }: { venture: Venture & { identity: Record<string, unknown> | null }; onLinked: () => void }): React.ReactElement {
  const id = venture.identity;
  const [num, setNum] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function lookup(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures/lookup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ registration_number: num, venture_id: venture.id }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `lookup failed (${r.status})`);
      onLinked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const rows: Array<[string, string | null]> = id
    ? (
        [
          ["Legal name", ident(id, "company_name")],
          ["Number", ident(id, "company_number")],
          ["Status", ident(id, "company_status")],
          ["Type", ident(id, "type")],
          ["Incorporated", ident(id, "date_of_creation")],
          ["Registered office", ident(id, "registered_office")],
        ] as Array<[string, string | null]>
      ).filter(([, v]) => Boolean(v))
    : [];

  return (
    <div className="card">
      <div className="ctxtag">Identity</div>
      {id ? (
        <div>
          {rows.map(([k, v]) => (
            <div className="identity-row" key={k}>
              <span className="identity-row__k">{k}</span>
              <span className="identity-row__v">{v}</span>
            </div>
          ))}
          <p className="screen-sub" style={{ marginTop: "var(--s3)" }}>via Companies House</p>
        </div>
      ) : (
        <div className="field">
          <p className="screen-sub" style={{ marginTop: 0 }}>Verify this venture against the UK register.</p>
          <label className="field__label" htmlFor="ch-num">Companies House number</label>
          <input id="ch-num" className="input" placeholder="e.g. 12345678 or SC123456" value={num} onChange={(e) => setNum(e.target.value)} />
          {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
          <button className="btn btn--ghost" disabled={busy || !num.trim()} onClick={() => void lookup()}>
            <Icon name="search" cls="i i-sm" />{busy ? "Looking up…" : "Look up company"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Attach-resource bottom sheet ─────────────────────────────────────────────
function AttachSheet({ ventureId, onClose, onAttached }: { ventureId: string; onClose: () => void; onAttached: () => void }): React.ReactElement {
  const [kind, setKind] = React.useState(RES_KINDS[0] ?? "social_account");
  const [provider, setProvider] = React.useState("");
  const [externalRef, setExternalRef] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ venture_id: ventureId, kind, provider, external_ref: externalRef, label: label || undefined }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `attach failed (${r.status})`);
      onAttached();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-label="Attach a resource" onClick={onClose}>
      <div className="sheet sheet-dock" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grip" />
        <div className="sheet-head">
          <h3>Attach a resource</h3>
          <button className="sheet-x" aria-label="Close" onClick={onClose}><Icon name="x" cls="i i-sm" /></button>
        </div>
        <div className="sheet-fields">
          <div className="field">
            <span className="field__label">Kind</span>
            <div className="seg" role="tablist">
              {RES_KINDS.map((k) => (
                <button key={k} className="seg__opt" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
                  {RES_META[k]?.label ?? k}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="r-provider">Provider</label>
            <input id="r-provider" className="input" placeholder="e.g. mailchimp, ga4, x, linkedin" value={provider} onChange={(e) => setProvider(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="r-ref">Handle / ID <span style={{ fontWeight: 400 }}>(not a secret — creds stay in the vault)</span></label>
            <input id="r-ref" className="input" placeholder="the provider's account/property id" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="r-label">Label <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input id="r-label" className="input" placeholder="human name" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
          <button className="btn btn--primary btn--block btn--lg" disabled={busy || !provider.trim() || !externalRef.trim()} onClick={() => void submit()}>
            {busy ? "Attaching…" : "Attach resource"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create-venture bottom sheet ──────────────────────────────────────────────
const KIND_OPTS: Array<[string, string]> = [["org", "Org"], ["venture", "Venture"], ["project", "Project"]];
const LEGAL_OPTS: Array<[string, string]> = [["", "—"], ["ltd", "Ltd"], ["sole_trader", "Sole trader"], ["holding", "Holding"]];

function CreateVentureSheet({ ventures, defaultParentId, onClose, onCreated }: { ventures: Venture[]; defaultParentId?: string | null; onClose: () => void; onCreated: (id: string) => void }): React.ReactElement {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState("venture");
  const [legal, setLegal] = React.useState("");
  const [parentId, setParentId] = React.useState<string>(defaultParentId ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Indented option list so the parent picker reflects the same tree as the scope switcher.
  const parentOpts = ventureTree(ventures);

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, kind, legal_type: legal || undefined, parent_id: parentId || undefined }),
      });
      const j = (await r.json()) as { error?: string; venture?: { id: string } };
      if (!r.ok || !j.venture) throw new Error(j.error ?? `create failed (${r.status})`);
      onCreated(j.venture.id);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-label="Add a venture" onClick={onClose}>
      <div className="sheet sheet-dock" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grip" />
        <div className="sheet-head">
          <h3>Add a venture</h3>
          <button className="sheet-x" aria-label="Close" onClick={onClose}><Icon name="x" cls="i i-sm" /></button>
        </div>
        <div className="sheet-fields">
          <div className="field">
            <label className="field__label" htmlFor="v-name">Name</label>
            <input id="v-name" className="input" placeholder="e.g. Northwind Studio" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <span className="field__label">Kind</span>
            <div className="seg" role="tablist">
              {KIND_OPTS.map(([k, label]) => (
                <button key={k} className="seg__opt" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field__label">Legal type <span style={{ fontWeight: 400 }}>(optional)</span></span>
            <div className="seg" role="tablist">
              {LEGAL_OPTS.map(([k, label]) => (
                <button key={k || "none"} className="seg__opt" role="tab" aria-selected={legal === k} onClick={() => setLegal(k)}>{label}</button>
              ))}
            </div>
          </div>
          {ventures.length > 0 ? (
            <div className="field">
              <label className="field__label" htmlFor="v-parent">Parent venture <span style={{ fontWeight: 400 }}>(optional — nests it under another)</span></label>
              <select id="v-parent" className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">None — top-level</option>
                {parentOpts.map(({ v, depth }) => (
                  <option key={v.id} value={v.id}>{`${"  ".repeat(depth)}${depth > 0 ? "↳ " : ""}${v.name}`}</option>
                ))}
              </select>
            </div>
          ) : null}
          {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
          <button className="btn btn--primary btn--block btn--lg" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {busy ? "Adding…" : "Add venture"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function VenturesScreen(): React.ReactElement {
  const [data, setData] = React.useState<VenturesPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [venture, setVenture] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState(false);
  const [createSheet, setCreateSheet] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);
  const onCreated = React.useCallback((id: string) => { setVenture(id); reload(); }, [reload]);

  React.useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const qs = venture ? `?venture=${encodeURIComponent(venture)}` : "";
        const r = await authFetch(`/api/charles/ventures${qs}`);
        if (!r.ok) throw new Error(`ventures load failed (${r.status})`);
        const json = (await r.json()) as VenturesPayload;
        if (cancelled) return;
        setData(json);
        setError(null);
        if (!venture && json.current) setVenture(json.current.id);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [venture, reloadKey]);

  const head = (
    <ScreenHead
      title={data?.current?.name ?? "Ventures"}
      sub={data?.current ? `${data.current.legal_type ? data.current.legal_type + " · " : ""}${data.current.kind}` : undefined}
      action={data && data.ventures.length > 0 ? <ScopeSwitcher ventures={data.ventures} currentId={venture} onPick={setVenture} onAdd={() => setCreateSheet(true)} /> : undefined}
    />
  );

  if (error) {
    return (
      <div className="ven-screen" style={{ padding: "var(--s5)" }}>
        {head}
        <div className="card" style={{ borderColor: "var(--alert)" }}>
          <div className="card__title">Couldn’t load ventures</div>
          <p className="screen-sub">{error}</p>
        </div>
      </div>
    );
  }
  if (!data) {
    return <div className="ven-screen" style={{ padding: "var(--s5)" }}>{head}<Skeleton /></div>;
  }
  if (data.ventures.length === 0) {
    return (
      <div className="ven-screen" style={{ padding: "var(--s5)" }}>
        {head}
        <Empty icon="ventures" title="No ventures yet" body="A venture is a business or holding. Add one to scope your books, CRM and resources." cta="Add venture" onCta={() => setCreateSheet(true)} />
        {createSheet ? <CreateVentureSheet ventures={[]} onClose={() => setCreateSheet(false)} onCreated={onCreated} /> : null}
      </div>
    );
  }

  const current = data.current!;
  const others = data.ventures.filter((v) => v.id !== current.id);
  const activeRes = data.resources.filter((r) => r.status === "active");
  const parent = current.parent_id ? data.ventures.find((v) => v.id === current.parent_id) ?? null : null;
  const parentName = parent?.name ?? current.parent_name ?? null;
  const children = data.ventures.filter((v) => v.parent_id === current.id);

  return (
    <div className="ven-screen" style={{ padding: "var(--s5)" }}>
      {head}

      <div className="ven-layout">
        <div className="ven-main">
          {parentName ? (
            <p className="screen-sub" style={{ marginTop: 0, marginBottom: "var(--s3)" }}>
              Part of{" "}
              {parent ? (
                <button onClick={() => setVenture(parent.id)} style={{ background: "none", border: "none", padding: 0, color: "var(--accent-link)", cursor: "pointer", font: "inherit" }}>{parentName}</button>
              ) : (
                <span style={{ color: "var(--text)" }}>{parentName}</span>
              )}
            </p>
          ) : null}
          <div className="grid-2">
            <StatTile label="Linked resources" value={activeRes.length} foot={<span className="screen-sub" style={{ marginTop: 0 }}>{activeRes.length === 1 ? "account" : "accounts"} attached</span>} />
            <StatTile
              label="Identity"
              value={current.legal_type ? current.legal_type.replace("_", " ") : (current.identity ? "Verified" : "—")}
              foot={<span className="screen-sub" style={{ marginTop: 0 }}>{current.status === "active" ? "Active" : current.status}</span>}
            />
          </div>

          <div className="card" style={{ marginTop: 16, paddingTop: 8, paddingBottom: 8 }}>
            <div className="card__head" style={{ marginTop: 12 }}>
              <div className="card__title">Linked resources</div>
              <button className="card__action" onClick={() => setSheet(true)}>+ Attach</button>
            </div>
            {activeRes.length === 0 ? (
              <p className="screen-sub" style={{ padding: "8px 0 16px" }}>No accounts attached yet — link a social account, mailing list, or analytics property.</p>
            ) : (
              <div className="loglist">
                {activeRes.map((r) => {
                  const meta = RES_META[r.kind] ?? { icon: "link", label: r.kind };
                  return (
                    <div className="logrow res-row" key={r.id}>
                      <span className="res-ic"><Icon name={meta.icon} /></span>
                      <span className="logrow__main">
                        <span className="logrow__primary">{r.label || r.provider}</span>
                        <span className="logrow__meta">{meta.label} · {r.provider}</span>
                      </span>
                      <span className={"pill pill--" + resTone(r.status)}><span className="pill__dot" />Connected</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {children.length > 0 ? (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card__head">
                <div className="card__title">Nested ventures</div>
                <button className="card__action" onClick={() => setCreateSheet(true)}>+ Add child</button>
              </div>
              <div className="loglist">
                {children.map((v) => (
                  <button className="logrow" key={v.id} style={{ background: "none", border: "none", borderBottom: "1px solid var(--border)", textAlign: "left", cursor: "pointer", width: "100%" }} onClick={() => setVenture(v.id)}>
                    <span className="logrow__main">
                      <span className="logrow__primary">{v.name}</span>
                      <span className="logrow__meta">{v.legal_type ? v.legal_type + " · " : ""}{v.kind}</span>
                    </span>
                    <Icon name="chevron" cls="i i-sm" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {others.length > 0 ? (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card__head"><div className="card__title">Other ventures</div></div>
              <div className="loglist">
                {others.map((v) => (
                  <button className="logrow" key={v.id} style={{ background: "none", border: "none", borderBottom: "1px solid var(--border)", textAlign: "left", cursor: "pointer", width: "100%" }} onClick={() => setVenture(v.id)}>
                    <span className="logrow__main">
                      <span className="logrow__primary">{v.name}</span>
                      <span className="logrow__meta">{v.legal_type ? v.legal_type + " · " : ""}{v.kind}</span>
                    </span>
                    <Icon name="chevron" cls="i i-sm" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <p className="screen-sub" style={{ marginTop: 16 }}>
            Cash &amp; pipeline appear here once Books and CRM are connected.
          </p>
        </div>

        <aside className="ven-aside">
          <IdentityPanel venture={current} onLinked={reload} />
        </aside>
      </div>

      {sheet ? <AttachSheet ventureId={current.id} onClose={() => setSheet(false)} onAttached={reload} /> : null}
      {createSheet ? <CreateVentureSheet ventures={data.ventures} onClose={() => setCreateSheet(false)} onCreated={onCreated} /> : null}
    </div>
  );
}
