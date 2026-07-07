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

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import * as React from "react";

import { authFetch } from "@/lib/auth";
import { uploadFile } from "@/lib/upload";
import { BoardsPanel } from "@/plugins/_shared/BoardsPanel";
import { ContentCardDrawer } from "@/plugins/_shared/ContentCardDrawer";
import { PersonaEditor } from "@/components/agents/PersonaEditor";
import { PersonaView } from "@/components/agents/PersonaView";
import { listAgentTools, type ToolCatalogEntry } from "@/lib/api/admin";

interface Venture {
  id: string;
  parent_id: string | null;
  parent_name?: string | null;
  name: string;
  slug: string;
  kind: string;
  legal_type: string | null;
  status: string;
  prompt?: string | null;
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
  github_repo: { icon: "link", label: "GitHub repo" },
  webpage: { icon: "link", label: "Webpage" },
  domain: { icon: "link", label: "Domain" },
  mailing_list: { icon: "mail", label: "Mailing list" },
  analytics_property: { icon: "analytics", label: "Analytics property" },
};
const RES_KINDS = Object.keys(RES_META);

// The social providers whose connected accounts can be attached as a venture asset. Each maps to a
// committed `/api/social-<value>/accounts` route (GET → { accounts: [...] }), so the attach picker
// can list a user's real connections instead of taking a free-text handle. Keep in sync with the
// social-* plugins under packages/.
const SOCIAL_PROVIDERS: Array<[string, string]> = [
  ["x", "X (Twitter)"],
  ["linkedin", "LinkedIn"],
  ["mastodon", "Mastodon"],
  ["bluesky", "Bluesky"],
  ["instagram", "Instagram"],
  ["facebook", "Facebook"],
  ["threads", "Threads"],
  ["youtube", "YouTube"],
];
interface SocialAccount {
  id: string;
  name: string;
  slug: string;
  host: string | null;
  external_handle: string | null;
  external_id: string | null;
  status: string;
}
// The canonical, lookup-friendly handle for an account: mastodon is `handle@host` (multi-host),
// everything else is the bare handle. Matches connections-kit's ConnectableRef.handle.
function accountHandle(a: SocialAccount): string {
  const h = (a.external_handle ?? "").trim();
  return a.host ? `${h}@${a.host}` : h;
}

// A domain from the charles-domains inventory (GET /api/charles/domains). Absent/empty when that
// opt-in plugin isn't loaded yet — the attach sheet then falls back to a manual domain field.
interface DomainRef {
  id: string;
  name: string;
  registrar: string | null;
  status: string;
}
// Kinds that attach a single free-text reference (no provider picker; provider is implicitly manual).
const SIMPLE_REF_META: Record<string, { label: string; placeholder: string }> = {
  github_repo: { label: "Repository", placeholder: "owner/name or GitHub URL" },
  webpage: { label: "URL", placeholder: "https://example.com" },
};

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
// The plugin's mount point. The selected venture lives in the PATH (/p/ventures/<slug>),
// not a query string, so a venture is a real, linkable route — breadcrumbs and the scope switcher
// navigate by slug and back/forward work. (House rule: no query-string routing in the UI.)
const BASE = "/p/ventures";

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

function ScopeSwitcher({ ventures, currentId, onPick, onAdd }: { ventures: Venture[]; currentId: string | null; onPick: (slug: string) => void; onAdd: () => void }): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  if (!ventures.length) return null;
  const current = ventures.find((v) => v.id === currentId) ?? ventures[0];
  const tree = ventureTree(ventures);
  const term = q.trim().toLowerCase();
  // Filtering flattens the tree (matches can be anywhere) so we drop indentation while searching.
  const shown = term ? tree.filter(({ v }) => v.name.toLowerCase().includes(term)) : tree;
  const showSearch = ventures.length > 6;
  const close = (): void => { setOpen(false); setQ(""); };
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
          <div className="scope__scrim" onClick={close} />
          <div className="scope__menu">
            <div className="scope__holding"><Icon name="bank" />Ventures<span className="scope__count num">{ventures.length}</span></div>
            {showSearch ? (
              <input
                className="scope__search input"
                type="text"
                placeholder="Search ventures…"
                value={q}
                autoFocus
                onChange={(e) => setQ(e.target.value)}
              />
            ) : null}
            <div className="scope__list">
              {shown.length ? shown.map(({ v, depth }) => {
                const indent = term ? 0 : depth;
                return (
                  <button key={v.id} className={"scope__item" + (v.id === current?.id ? " is-active" : "")} style={indent > 0 ? { paddingLeft: `calc(var(--s3) + ${indent} * var(--s4))` } : undefined} onClick={() => { onPick(v.slug); close(); }}>
                    <span className="scope__item-main">
                      <span className="scope__item-name">{indent > 0 ? <span style={{ color: "var(--faint)" }} aria-hidden="true">↳ </span> : null}{v.name}</span>
                      <span className="scope__item-kind">{v.legal_type ? v.legal_type + " · " : ""}{v.kind}</span>
                    </span>
                    {v.id === current?.id ? <Icon name="check" cls="i i-sm scope__check" /> : null}
                  </button>
                );
              }) : <div className="scope__empty">No ventures match “{q.trim()}”.</div>}
            </div>
            <button className="scope__add" onClick={() => { close(); onAdd(); }}><Icon name="add" />Add venture</button>
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
  // social_account picker state: the connected accounts for the chosen provider + the selection.
  const [accounts, setAccounts] = React.useState<SocialAccount[]>([]);
  const [accLoading, setAccLoading] = React.useState(false);
  const [accountId, setAccountId] = React.useState("");
  const [connectionId, setConnectionId] = React.useState("");
  // domain picker state: the charles-domains inventory (empty → manual fallback) + the selection.
  const [domains, setDomains] = React.useState<DomainRef[]>([]);
  const [domLoading, setDomLoading] = React.useState(false);
  const [domainId, setDomainId] = React.useState("");

  const isSocial = kind === "social_account";
  const isDomain = kind === "domain";
  const isSimpleRef = kind === "github_repo" || kind === "webpage";

  // Reset per-kind state whenever the kind changes (each kind is a different attach shape). Simple-ref
  // kinds attach as provider 'manual'; the rest start with no provider until one is chosen.
  function pickKind(k: string): void {
    setKind(k);
    setProvider(k === "github_repo" || k === "webpage" ? "manual" : "");
    setExternalRef("");
    setLabel("");
    setAccounts([]);
    setAccountId("");
    setConnectionId("");
    setDomains([]);
    setDomainId("");
    setErr(null);
    if (k === "domain") void loadDomains();
  }

  // Load the user's connected accounts for a social provider (owner-scoped; only active ones can be
  // attached). Failure (e.g. provider never connected → no schema) is treated as "no accounts".
  async function loadAccounts(prov: string): Promise<void> {
    setAccounts([]);
    setAccountId("");
    setConnectionId("");
    setExternalRef("");
    if (!prov) return;
    setAccLoading(true);
    try {
      const r = await authFetch(`/api/social-${prov}/accounts`);
      const j = (await r.json().catch(() => ({}))) as { accounts?: SocialAccount[] };
      setAccounts((j.accounts ?? []).filter((a) => a.status === "active"));
    } catch {
      setAccounts([]);
    } finally {
      setAccLoading(false);
    }
  }

  // Load the domain inventory. If the charles-domains plugin isn't loaded (or there are none yet),
  // fall back to a manual domain field (provider 'manual') so a domain can still be tracked by hand.
  async function loadDomains(): Promise<void> {
    setDomains([]);
    setDomainId("");
    setExternalRef("");
    setConnectionId("");
    setDomLoading(true);
    try {
      const r = await authFetch(`/api/charles/domains`);
      const j = (await r.json().catch(() => ({}))) as { domains?: DomainRef[] };
      const list = (j.domains ?? []).filter((d) => d.status !== "archived");
      setDomains(list);
      if (!list.length) setProvider("manual");
    } catch {
      setDomains([]);
      setProvider("manual");
    } finally {
      setDomLoading(false);
    }
  }

  function pickProvider(prov: string): void {
    setProvider(prov);
    if (isSocial) void loadAccounts(prov);
  }

  // Selecting a connected account fills the canonical handle (external_ref), binds the stable
  // connection id (external_id, else slug — mirrors ConnectableRef.id), and defaults the label.
  function pickAccount(id: string): void {
    setAccountId(id);
    const a = accounts.find((x) => x.id === id);
    if (!a) {
      setExternalRef("");
      setConnectionId("");
      return;
    }
    setExternalRef(accountHandle(a));
    setConnectionId(a.external_id?.trim() || a.slug);
    if (!label.trim()) setLabel(a.name);
  }

  // Selecting an inventory domain binds its name (external_ref), id (connection_id) and registrar
  // (provider — the DB CHECK allows manual/godaddy/cyberfolks for the domain kind).
  function pickDomain(id: string): void {
    setDomainId(id);
    const d = domains.find((x) => x.id === id);
    if (!d) {
      setExternalRef("");
      setConnectionId("");
      setProvider("");
      return;
    }
    setExternalRef(d.name);
    setConnectionId(d.id);
    setProvider(d.registrar || "manual");
    if (!label.trim()) setLabel(d.name);
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          venture_id: ventureId,
          kind,
          provider,
          external_ref: externalRef,
          label: label || undefined,
          connection_id: connectionId || undefined,
        }),
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

  const canSubmit = !busy && Boolean(provider.trim()) && Boolean(externalRef.trim());

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
            <label className="field__label" htmlFor="r-kind">Kind</label>
            <select id="r-kind" className="input" value={kind} onChange={(e) => pickKind(e.target.value)}>
              {RES_KINDS.map((k) => (
                <option key={k} value={k}>{RES_META[k]?.label ?? k}</option>
              ))}
            </select>
          </div>

          {isSocial ? (
            <>
              <div className="field">
                <label className="field__label" htmlFor="r-provider">Platform</label>
                <select id="r-provider" className="input" value={provider} onChange={(e) => pickProvider(e.target.value)}>
                  <option value="">Choose a platform…</option>
                  {SOCIAL_PROVIDERS.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
              {provider ? (
                <div className="field">
                  <label className="field__label" htmlFor="r-account">Connected account</label>
                  {accLoading ? (
                    <div className="skel" style={{ height: 40 }} />
                  ) : accounts.length ? (
                    <select id="r-account" className="input" value={accountId} onChange={(e) => pickAccount(e.target.value)}>
                      <option value="">Choose an account…</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>{a.name} — {accountHandle(a)}</option>
                      ))}
                    </select>
                  ) : (
                    <p className="screen-sub" style={{ marginTop: 0 }}>
                      No connected {SOCIAL_PROVIDERS.find(([v]) => v === provider)?.[1] ?? "this platform"} accounts.{" "}
                      <a href={`/p/social-${encodeURIComponent(provider)}`}>Connect one</a>, then come back.
                    </p>
                  )}
                </div>
              ) : null}
            </>
          ) : isDomain ? (
            <div className="field">
              <label className="field__label" htmlFor="r-domain">Domain</label>
              {domLoading ? (
                <div className="skel" style={{ height: 40 }} />
              ) : domains.length ? (
                <select id="r-domain" className="input" value={domainId} onChange={(e) => pickDomain(e.target.value)}>
                  <option value="">Choose a domain…</option>
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}{d.registrar ? ` · ${d.registrar}` : ""}</option>
                  ))}
                </select>
              ) : (
                <>
                  <input id="r-domain" className="input" placeholder="example.com" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} />
                  <p className="screen-sub" style={{ marginTop: 0 }}>
                    No imported domains yet — <Link href="/p/charles-domains">add or import in Domains</Link>, or type one to track it manually.
                  </p>
                </>
              )}
            </div>
          ) : isSimpleRef ? (
            <div className="field">
              <label className="field__label" htmlFor="r-ref">{SIMPLE_REF_META[kind]?.label ?? "Reference"}</label>
              <input id="r-ref" className="input" placeholder={SIMPLE_REF_META[kind]?.placeholder ?? ""} value={externalRef} onChange={(e) => setExternalRef(e.target.value)} />
            </div>
          ) : (
            <>
              <div className="field">
                <label className="field__label" htmlFor="r-provider">Provider</label>
                <input id="r-provider" className="input" placeholder="e.g. mailchimp, ga4" value={provider} onChange={(e) => setProvider(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="r-ref">Handle / ID <span style={{ fontWeight: 400 }}>(not a secret — creds stay in the vault)</span></label>
                <input id="r-ref" className="input" placeholder="the provider's account/property id" value={externalRef} onChange={(e) => setExternalRef(e.target.value)} />
              </div>
            </>
          )}

          <div className="field">
            <label className="field__label" htmlFor="r-label">Label <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input id="r-label" className="input" placeholder="human name" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
          <button className="btn btn--primary btn--block btn--lg" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Attaching…" : "Attach resource"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit-resource bottom sheet ───────────────────────────────────────────────
// Rename the label of an attached connection, or detach it. The connection binding itself
// (provider/handle) is shown read-only — change it by detaching and re-attaching.
function EditResourceSheet({ resource, onClose, onSaved }: { resource: Resource; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const [label, setLabel] = React.useState(resource.label ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const meta = RES_META[resource.kind] ?? { icon: "link", label: resource.kind };

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: resource.id, label: label.trim() || undefined }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `save failed (${r.status})`);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function detach(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures?id=${encodeURIComponent(resource.id)}`, { method: "DELETE" });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `detach failed (${r.status})`);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-label="Edit connection" onClick={onClose}>
      <div className="sheet sheet-dock" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grip" />
        <div className="sheet-head">
          <h3>Edit connection</h3>
          <button className="sheet-x" aria-label="Close" onClick={onClose}><Icon name="x" cls="i i-sm" /></button>
        </div>
        <div className="sheet-fields">
          <div className="field">
            <span className="field__label">Connection</span>
            <div className="logrow res-row" style={{ borderBottom: "none" }}>
              <span className="res-ic"><Icon name={meta.icon} /></span>
              <span className="logrow__main">
                <span className="logrow__primary">{resource.external_ref}</span>
                <span className="logrow__meta">{meta.label} · {resource.provider}</span>
              </span>
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="er-label">Label <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input id="er-label" className="input" placeholder="human name" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
          <button className="btn btn--primary btn--block btn--lg" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn btn--ghost btn--block" disabled={busy} style={{ color: "var(--alert)" }} onClick={() => void detach()}>
            <Icon name="x" cls="i i-sm" />Detach
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Create-venture bottom sheet ──────────────────────────────────────────────
const KIND_OPTS: Array<[string, string]> = [["org", "Org"], ["venture", "Venture"], ["project", "Project"], ["employment", "Employment"]];
const LEGAL_OPTS: Array<[string, string]> = [["", "—"], ["ltd", "Ltd"], ["sole_trader", "Sole trader"], ["holding", "Holding"]];

function CreateVentureSheet({ ventures, defaultParentId, onClose, onCreated }: { ventures: Venture[]; defaultParentId?: string | null; onClose: () => void; onCreated: (slug: string) => void }): React.ReactElement {
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
      const j = (await r.json()) as { error?: string; venture?: { id: string; slug: string } };
      if (!r.ok || !j.venture) throw new Error(j.error ?? `create failed (${r.status})`);
      onCreated(j.venture.slug);
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

// ── Venture context (operator prompt) ────────────────────────────────────────
// Standing context the operator writes to give Charles more on this venture. Stored as markdown in
// metadata.prompt (agent reads it via venture_get). Read view renders it formatted; editing reuses
// the persona WYSIWYG (PersonaEditor) so you get rich text + `@tool` tagging, same as agent personas.
function ContextCard({ venture, onSaved }: { venture: Venture; onSaved: () => void }): React.ReactElement {
  const stored = venture.prompt ?? "";
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(stored);
  const [tools, setTools] = React.useState<ToolCatalogEntry[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Tool catalog for the @-mention popover (same source the agent persona editor uses). Fetched once.
  React.useEffect(() => { void listAgentTools().then(setTools).catch(() => setTools([])); }, []);
  // Reset when switching ventures / after a save reloads the stored value.
  React.useEffect(() => { setDraft(venture.prompt ?? ""); setEditing(false); setErr(null); }, [venture.id, venture.prompt]);

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ venture_id: venture.id, prompt: draft }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `save failed (${r.status})`);
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card__head">
        <div className="card__title">Context</div>
        {!editing ? (
          <button className="card__action" onClick={() => { setDraft(stored); setEditing(true); }}>
            {stored.trim() ? "Edit" : "+ Add context"}
          </button>
        ) : null}
      </div>

      {editing ? (
        <>
          <p className="screen-sub" style={{ marginTop: 0 }}>
            What this venture is, who it’s for, and how Charles should act here. Type <strong>@</strong> to reference a tool.
          </p>
          <PersonaEditor value={draft} onChange={setDraft} tools={tools} rows={6} />
          {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
          <div style={{ display: "flex", gap: "var(--s2)", marginTop: "var(--s2)" }}>
            <button className="btn btn--primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => { setDraft(stored); setEditing(false); setErr(null); }}>Cancel</button>
          </div>
        </>
      ) : stored.trim() ? (
        <PersonaView persona={stored} tools={tools} className="text-sm text-foreground" />
      ) : (
        <p className="screen-sub" style={{ marginTop: 0 }}>
          No context yet — add standing guidance for Charles on this venture (what it is, who it’s for, how to act). Charles reads it when working here.
        </p>
      )}
    </div>
  );
}

// ── Venture hub tabs ─────────────────────────────────────────────────────────
const VENTURE_TABS: Array<[string, string]> = [
  ["dashboard", "Dashboard"], ["resources", "Resources"], ["boards", "Boards"], ["content", "Content"], ["decisions", "Decisions"],
];
function TabBar({ tab, onSelect }: { tab: string; onSelect: (t: string) => void }): React.ReactElement {
  return (
    <div role="tablist" aria-label="Venture sections" style={{ display: "flex", gap: "var(--s1)", borderBottom: "1px solid var(--border)", marginBottom: "var(--s4)", flexWrap: "wrap" }}>
      {VENTURE_TABS.map(([id, label]) => {
        const active = tab === id;
        return (
          <button key={id} role="tab" aria-selected={active} onClick={() => onSelect(id)}
            style={{ background: "none", border: "none", borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent", color: active ? "var(--text)" : "var(--muted)", padding: "var(--s2) var(--s3)", cursor: "pointer", font: "inherit", fontWeight: active ? 600 : 400, marginBottom: -1 }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

// The channels a brand sub-scope can target (mirror of packages/content scope.ts CHANNELS).
const CHANNELS = ["linkedin", "instagram", "x", "threads", "tiktok", "youtube", "mastodon", "bluesky", "newsletter", "blog"];
interface BrandLayer { voice: string | null; styleguide: string | null; language: string | null; reference_images: string[] }

// Per-venture brand editor. Calls the content plugin's scope-aware brand API; the cascade
// (default → venture ancestry → this venture → channel) is resolved server-side, so blank channel
// fields show the inherited value as a placeholder and you only fill the deltas.
function BrandEditor({ ventureId }: { ventureId: string }): React.ReactElement {
  const [channel, setChannel] = React.useState("");
  const [voice, setVoice] = React.useState("");
  const [styleguide, setStyleguide] = React.useState("");
  const [language, setLanguage] = React.useState("");
  const [eff, setEff] = React.useState<BrandLayer>({ voice: null, styleguide: null, language: null, reference_images: [] });
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const scope = channel === "" ? `venture:${ventureId}` : `venture:${ventureId}:${channel}`;

  const load = React.useCallback(async (sc: string) => {
    setStatus(null);
    try {
      const r = await authFetch(`/api/content/brand?scope=${encodeURIComponent(sc)}`);
      const j = (await r.json()) as { layer?: BrandLayer; effective?: BrandLayer };
      const l = j.layer ?? { voice: null, styleguide: null, language: null, reference_images: [] };
      setVoice(l.voice ?? ""); setStyleguide(l.styleguide ?? ""); setLanguage(l.language ?? "");
      setEff(j.effective ?? { voice: null, styleguide: null, language: null, reference_images: [] });
    } catch { /* leave as-is */ }
  }, []);
  React.useEffect(() => { void load(scope); }, [scope, load]);

  const save = React.useCallback(async () => {
    setSaving(true); setStatus(null);
    try {
      const r = await authFetch(`/api/content/brand?scope=${encodeURIComponent(scope)}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ voice, styleguide, language }),
      });
      setStatus(r.ok ? "Saved." : "Could not save.");
      if (r.ok) void load(scope);
    } catch { setStatus("Could not save."); } finally { setSaving(false); }
  }, [scope, voice, styleguide, language, load]);

  const ph = (k: keyof BrandLayer, fallback: string): string => {
    const v = eff[k];
    return channel !== "" && typeof v === "string" && v.trim() ? `Inherited: ${v.trim()}` : fallback;
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card__head"><div className="card__title">Brand</div></div>
      <p className="screen-sub" style={{ marginTop: 0 }}>
        Grounds every generation for this venture. Pick a channel to override just the deltas — blank fields inherit.
      </p>
      <div className="field">
        <label className="field__label" htmlFor="b-ch">Scope</label>
        <select id="b-ch" className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">Whole venture</option>
          {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="field">
        <label className="field__label">Voice &amp; tone</label>
        <textarea className="input" rows={2} value={voice} placeholder={ph("voice", "e.g. warm, plain-spoken, a bit contrarian; no jargon")} onChange={(e) => setVoice(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label">Visual style</label>
        <textarea className="input" rows={2} value={styleguide} placeholder={ph("styleguide", "e.g. bold sans headline, off-white bg, one accent colour")} onChange={(e) => setStyleguide(e.target.value)} />
      </div>
      <div className="field">
        <label className="field__label">Language rules</label>
        <textarea className="input" rows={2} value={language} placeholder={ph("language", "e.g. British English; say 'agent' not 'bot'; never hype")} onChange={(e) => setLanguage(e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: "var(--s3)", alignItems: "center", marginTop: "var(--s3)" }}>
        <button className="btn btn--primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
        {status ? <span className="screen-sub" style={{ margin: 0 }}>{status}</span> : null}
      </div>
    </div>
  );
}

// The single-venture content board — 6 canonical stages with hints, styled to the Charles design
// (content-board.jsx ContentBoard; classes from the content plugin's content.css).
const CB_STAGES: Array<[string, string, string]> = [
  ["concept", "Concept", "idea being worked in chat"],
  ["assets", "Assets", "images, files, PDFs gathered"],
  ["copy", "Copy", "per-channel drafts written"],
  ["distribution", "Distribution", "channels + resources wired"],
  ["scheduled", "Scheduled", "frozen, waiting for its time"],
  ["published", "Published", "executed by the system"],
];
const CB_STAGE_IDS = CB_STAGES.map((s) => s[0]);
const cbNorm = (s: string): string => (s === "review" ? "distribution" : CB_STAGE_IDS.includes(s) ? s : "concept");
const CB_CHANNELS: Record<string, string> = { linkedin: "in", x: "X", bluesky: "bs", threads: "@", newsletter: "✉", youtube: "▶", shorts: "⧉", blog: "¶", pdf: "PDF", instagram: "ig", tiktok: "tt", mastodon: "m" };
const CB_THUMB: Record<string, string> = { carousel: "carousel · 6 slides", post: "post", image_prompt: "concept", article: "doc", thread: "thread", idea: "concept", video: "4K video", pdf: "PDF" };
interface CBCard { id: string; title: string; body: string | null; status: string; venture_id: string | null; labels: string[]; source_conv: string | null }

function thumbFor(labels: string[]): string {
  for (const l of labels) if (CB_THUMB[l]) return CB_THUMB[l];
  return "concept";
}

function ContentBoard({ venture }: { venture: Venture }): React.ReactElement {
  const [cards, setCards] = React.useState<CBCard[] | null>(null);
  const [open, setOpen] = React.useState<CBCard | null>(null);
  const load = React.useCallback(async () => {
    try {
      const r = await authFetch("/api/content/board");
      const j = (await r.json()) as { cards?: Array<CBCard & { venture_id: string | null }> };
      setCards((j.cards ?? []).filter((c) => c.venture_id === venture.id));
    } catch { setCards([]); }
  }, [venture.id]);
  React.useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ marginTop: 16 }}>
      {!cards ? <p className="screen-sub">Loading…</p> : (
        <div className="cboard">
          {CB_STAGES.map(([id, label, hint], si) => {
            const col = cards.filter((c) => cbNorm(c.status) === id);
            return (
              <div className={"ccol" + (id === "published" ? " ccol--terminal" : "")} key={id}>
                <div className="ccol__head"><span className="ccol__idx">{si + 1}</span><span className="ccol__name">{label}</span><span className="ccol__count">{col.length}</span></div>
                <div className="ccol__hint">{hint}</div>
                {col.map((card) => (
                  <button className="ccard" key={card.id} onClick={() => setOpen(card)}>
                    <div className="cthumb"><span className="cthumb__tag">{thumbFor(card.labels)}</span></div>
                    <div className="ccard__body">
                      <div className="ccard__title">{card.title}</div>
                      <div className="ccard__meta">
                        {card.labels.filter((l) => CB_CHANNELS[l]).map((l) => <span className="chchip" key={l}><span className="chchip__g">{CB_CHANNELS[l]}</span>{l}</span>)}
                      </div>
                    </div>
                  </button>
                ))}
                {col.length === 0 && <div style={{ fontSize: 12, color: "var(--faint)", textAlign: "center", padding: "10px 0" }}>—</div>}
              </div>
            );
          })}
        </div>
      )}

      {open ? <ContentCardDrawer cardId={open.id} onClose={() => setOpen(null)} onChanged={load} /> : null}
    </div>
  );
}

// A brand-asset thumbnail streamed from the file store. Uses /api/fs/blob (the engine route that serves
// ANY backend — local pg bytea OR S3-offloaded) so assets uploaded direct-to-S3 still render.
function BrandThumb({ id }: { id: string }): React.ReactElement {
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false; let obj: string | null = null;
    void (async () => {
      try { const r = await authFetch(`/api/fs/blob?id=${encodeURIComponent(id)}`); if (!r.ok || cancelled) return; obj = URL.createObjectURL(await r.blob()); if (cancelled) { URL.revokeObjectURL(obj); return; } setUrl(obj); } catch { /* ignore */ }
    })();
    return () => { cancelled = true; if (obj) URL.revokeObjectURL(obj); };
  }, [id]);
  return url
    ? <img src={url} alt="brand asset" style={{ width: 88, height: 88, objectFit: "contain", borderRadius: "var(--r-sm)", border: "1px solid var(--border)", background: "var(--surface)" }} />
    : <div className="skel" style={{ width: 88, height: 88, borderRadius: "var(--r-sm)" }} />;
}

// Suggested roles for the datalist — the operator can also type a freeform meaning ("Newsletter footer").
const BRAND_ROLES = [
  "Logo", "Logo (dark)", "Icon / favicon", "Avatar",
  "Banner", "LinkedIn banner", "Bluesky banner", "X header", "Facebook cover", "YouTube banner",
  "Mail header", "Newsletter footer", "OG image", "Reference",
];

interface BrandAsset { id: string; role: string }

// Typed brand assets held against the venture — each file tagged with its MEANING (Logo, Banner,
// Bluesky banner, Mail header, …). Stored on the venture-scope brand kit as brand_assets; the API also
// keeps reference_images (= the ids) in sync so the agent's brand block is unchanged. Uploads go through
// uploadFile → direct-to-S3 when enabled (banners/video bypass the DB + Vercel cap).
function BrandAssets({ venture }: { venture: Venture }): React.ReactElement {
  const scope = `venture:${venture.id}`;
  const [assets, setAssets] = React.useState<BrandAsset[]>([]);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    void (async () => {
      try {
        const r = await authFetch(`/api/content/brand?scope=${encodeURIComponent(scope)}`);
        const j = (await r.json()) as { layer?: { brand_assets?: BrandAsset[]; reference_images?: string[] } };
        const typed = j.layer?.brand_assets ?? [];
        // One-time migration: older kits only have untyped reference_images — surface them as "Reference".
        if (typed.length) setAssets(typed);
        else setAssets((j.layer?.reference_images ?? []).map((id) => ({ id, role: "Reference" })));
      } catch { /* ignore */ }
    })();
  }, [scope]);
  const save = React.useCallback(async (next: BrandAsset[]) => {
    setAssets(next);
    try { await authFetch(`/api/content/brand?scope=${encodeURIComponent(scope)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ brand_assets: next }) }); } catch { /* ignore */ }
  }, [scope]);
  const upload = React.useCallback(async (file: File) => {
    setBusy(true);
    try {
      const node = await uploadFile(file);
      // Seed a sensible default role from the filename, else "Reference" — the operator refines it.
      const lname = file.name.toLowerCase();
      const guess = BRAND_ROLES.find((r) => { const w = r.toLowerCase().split(" ")[0]; return w ? lname.includes(w) : false; }) ?? "Reference";
      if (node.id) await save([...assets, { id: node.id, role: guess }]);
    } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }, [assets, save]);
  const setRole = (id: string, role: string): void => { void save(assets.map((a) => (a.id === id ? { ...a, role } : a))); };
  const remove = (id: string): void => { void save(assets.filter((a) => a.id !== id)); };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card__head"><div className="card__title">Brand assets</div></div>
      <p className="screen-sub" style={{ marginTop: 0 }}>
        Logos, banners &amp; headers held against {venture.name}, each tagged with its meaning — reused across content and layered into generation to stay on-brand.
      </p>
      <datalist id="brand-roles">{BRAND_ROLES.map((r) => <option key={r} value={r} />)}</datalist>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s3)", alignItems: "flex-start", marginTop: "var(--s2)" }}>
        {assets.map((a) => (
          <div key={a.id} style={{ position: "relative", display: "flex", flexDirection: "column", gap: 4, width: 88 }}>
            <BrandThumb id={a.id} />
            <input
              list="brand-roles" value={a.role} placeholder="Role…"
              onChange={(e) => setRole(a.id, e.target.value)}
              style={{ width: 88, fontSize: "var(--fs-13)", padding: "2px 4px", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface)", color: "var(--text)" }}
            />
            <button onClick={() => remove(a.id)} title="Remove" style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--muted)", cursor: "pointer", fontSize: 12, lineHeight: 1 }}>×</button>
          </div>
        ))}
        <input ref={fileRef} type="file" accept="image/*,video/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        <button className="btn btn--ghost" disabled={busy} onClick={() => fileRef.current?.click()} style={{ height: 88, minWidth: 88, borderStyle: "dashed", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2 }}>{busy ? "…" : <><span style={{ fontSize: 20 }}>+</span><span style={{ fontSize: "var(--fs-13)" }}>Add asset</span></>}</button>
      </div>
    </div>
  );
}

// ── Decisions tab ────────────────────────────────────────────────────────────
// Read-only view of the venture's decision log (eidan.kv namespace='decisions', via
// /api/charles/ventures/decisions). Decisions are authored/edited by the agent (decision_record);
// this surfaces what's on record so the operator can see per-venture targeting/positioning/pricing
// choices without asking the agent. Grouped by status; newest first within each group.
interface VentureDecision {
  id: string | null;
  title: string;
  decision: string;
  rationale: string;
  status: string;
  tags: string[];
  venture: string | null;
  updatedAt: string | null;
}

function decisionTone(status: string): string {
  return status === "accepted" ? "ok" : status === "proposed" ? "warn" : "muted";
}

const DECISION_STATUSES = ["accepted", "proposed", "superseded"];

// A decision card: read view (expand for why/tags), and an inline editor so the operator can correct
// the wording, flip the status, or delete a decision the agent recorded wrong — without going to chat.
function DecisionCard({ d, onChanged }: { d: VentureDecision; onChanged: () => void }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirmDel, setConfirmDel] = React.useState(false);
  const [f, setF] = React.useState({ title: d.title, decision: d.decision, rationale: d.rationale, status: d.status, tags: d.tags.join(", ") });
  React.useEffect(() => { setF({ title: d.title, decision: d.decision, rationale: d.rationale, status: d.status, tags: d.tags.join(", ") }); }, [d]);
  const when = d.updatedAt ? new Date(d.updatedAt).toLocaleDateString() : "";
  const inputStyle: React.CSSProperties = { width: "100%", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface)", color: "var(--text)", font: "inherit", fontSize: "var(--fs-13)" };

  const save = async (): Promise<void> => {
    if (!d.id) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/charles/ventures/decisions`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: d.id, title: f.title, decision: f.decision, rationale: f.rationale, status: f.status, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean) }),
      });
      if (r.ok) { setEditing(false); onChanged(); }
    } finally { setBusy(false); }
  };
  const del = async (): Promise<void> => {
    if (!d.id) return;
    setBusy(true);
    try { const r = await authFetch(`/api/charles/ventures/decisions?id=${encodeURIComponent(d.id)}`, { method: "DELETE" }); if (r.ok) onChanged(); }
    finally { setBusy(false); }
  };

  if (editing) {
    return (
      <div className="logrow" style={{ display: "block", borderBottom: "1px solid var(--border)", padding: "12px 0" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input style={inputStyle} value={f.title} placeholder="Title" onChange={(e) => setF({ ...f, title: e.target.value })} />
          <textarea style={{ ...inputStyle, minHeight: 64, resize: "vertical" }} value={f.decision} placeholder="The decision (what was decided)" onChange={(e) => setF({ ...f, decision: e.target.value })} />
          <textarea style={{ ...inputStyle, minHeight: 48, resize: "vertical" }} value={f.rationale} placeholder="Why (rationale)" onChange={(e) => setF({ ...f, rationale: e.target.value })} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select style={{ ...inputStyle, width: "auto" }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              {DECISION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input style={{ ...inputStyle, flex: 1, minWidth: 140 }} value={f.tags} placeholder="tags, comma, separated" onChange={(e) => setF({ ...f, tags: e.target.value })} />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <button className="btn" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
            <button className="btn btn--ghost" disabled={busy} onClick={() => { setEditing(false); setF({ title: d.title, decision: d.decision, rationale: d.rationale, status: d.status, tags: d.tags.join(", ") }); }}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="logrow" style={{ display: "block", borderBottom: "1px solid var(--border)", padding: "12px 0" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s2)", cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>
        <span className={"pill pill--" + decisionTone(d.status)}><span className="pill__dot" />{d.status}</span>
        <span className="logrow__primary" style={{ flex: 1 }}>{d.title}</span>
        {when ? <span className="logrow__meta">{when}</span> : null}
      </div>
      <p className="screen-sub" style={{ margin: "6px 0 0", color: "var(--text)", cursor: "pointer" }} onClick={() => setOpen((v) => !v)}>{d.decision}</p>
      {open ? (
        <>
          {d.rationale ? <p className="screen-sub" style={{ margin: "8px 0 0" }}><strong>Why:</strong> {d.rationale}</p> : null}
          {d.tags.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
              {d.tags.map((t) => <span className="chip" key={t}>{t}</span>)}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button className="btn btn--ghost" disabled={!d.id || busy} onClick={() => setEditing(true)}>Edit</button>
            {confirmDel ? (
              <>
                <span className="screen-sub" style={{ margin: 0 }}>Delete?</span>
                <button className="btn ven-danger__btn" disabled={busy} onClick={() => void del()}>{busy ? "…" : "Yes, delete"}</button>
                <button className="btn btn--ghost" disabled={busy} onClick={() => setConfirmDel(false)}>No</button>
              </>
            ) : (
              <button className="btn btn--ghost" disabled={!d.id || busy} onClick={() => setConfirmDel(true)} style={{ color: "var(--alert)" }}>Delete</button>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function DecisionsTab({ venture }: { venture: Venture }): React.ReactElement {
  const [decisions, setDecisions] = React.useState<VentureDecision[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures/decisions?venture=${encodeURIComponent(venture.slug)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { decisions?: VentureDecision[] };
      setDecisions(j.decisions ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [venture.slug]);

  React.useEffect(() => { setDecisions(null); void reload(); }, [reload]);

  return (
    <div className="card" style={{ marginTop: 16, paddingTop: 8, paddingBottom: 8 }}>
      <div className="card__head" style={{ marginTop: 12 }}>
        <div className="card__title">Decisions on record</div>
        {decisions ? <span className="logrow__meta">{decisions.length}</span> : null}
      </div>
      <p className="screen-sub" style={{ marginTop: 0 }}>
        Targeting, positioning, pricing &amp; strategy choices for {venture.name}. The agent records them (“record a decision…”); expand one to <strong>edit or delete</strong> it here.
      </p>
      {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>Couldn’t load decisions: {err}</p> : null}
      {decisions === null && !err ? <p className="screen-sub" style={{ padding: "8px 0" }}>Loading…</p> : null}
      {decisions && decisions.length === 0 ? (
        <p className="screen-sub" style={{ padding: "8px 0 16px" }}>No decisions recorded for {venture.name} yet. When you settle a targeting, pricing, or positioning choice in chat, ask the agent to record it and it’ll appear here.</p>
      ) : null}
      {decisions && decisions.length > 0 ? (
        <div className="loglist">
          {decisions.map((d, i) => <DecisionCard d={d} key={d.id ?? i} onChanged={() => void reload()} />)}
        </div>
      ) : null}
    </div>
  );
}

function ContentTab({ venture }: { venture: Venture }): React.ReactElement {
  return (
    <>
      <BrandEditor ventureId={venture.id} />
      <BrandAssets venture={venture} />
      <ContentBoard venture={venture} />
    </>
  );
}

export default function VenturesScreen(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  // The selected venture is the slug segment after BASE — path-based, not a query string. Null on the
  // bare /p/ventures route (we then canonicalise to the resolved venture's slug below).
  const slug = React.useMemo(() => {
    if (!pathname || !pathname.startsWith(BASE)) return null;
    const rest = pathname.slice(BASE.length).replace(/^\/+/, "");
    return rest ? decodeURIComponent(rest.split("/")[0]) : null;
  }, [pathname]);
  // The active tab is the SECOND path segment (/p/ventures/<slug>/<tab>), default "dashboard". A board
  // deep-link (/p/ventures/<slug>/boards/<boardId>) still resolves tab="boards" — BoardsPanel owns seg 3.
  const tab = React.useMemo(() => {
    if (!pathname || !pathname.startsWith(BASE)) return "dashboard";
    const seg = pathname.slice(BASE.length).replace(/^\/+/, "").split("/");
    return seg[1] || "dashboard";
  }, [pathname]);

  const [data, setData] = React.useState<VenturesPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [sheet, setSheet] = React.useState(false);
  const [createSheet, setCreateSheet] = React.useState(false);
  // Which venture a freshly-created one nests under: null = top-level ("Add venture"); a venture id =
  // "Add child" from a venture, so a project/sub-venture can be added at any depth (recursive).
  const [createParent, setCreateParent] = React.useState<string | null>(null);
  const [moveSheet, setMoveSheet] = React.useState(false);
  const [editRes, setEditRes] = React.useState<Resource | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);
  const [confirmDel, setConfirmDel] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [delErr, setDelErr] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);
  // Navigate to a venture by slug — a real route push, so back/forward and bookmarks all work.
  const goTo = React.useCallback((s: string) => { router.push(`${BASE}/${encodeURIComponent(s)}`); }, [router]);
  const selectTab = React.useCallback((name: string) => { if (slug) router.push(`${BASE}/${encodeURIComponent(slug)}/${name}`); }, [router, slug]);
  const openCreateTop = React.useCallback(() => { setCreateParent(null); setCreateSheet(true); }, []);
  const openCreateChild = React.useCallback((parentId: string) => { setCreateParent(parentId); setCreateSheet(true); }, []);
  const onCreated = React.useCallback((s: string) => { setCreateSheet(false); goTo(s); }, [goTo]);

  React.useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        // Resolve by slug from the path; fall back to a legacy ?venture=<id> link so old bookmarks
        // still land, then canonicalise the URL to the slug below.
        const legacy = !slug && typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("venture") : null;
        const wanted = slug ?? legacy;
        const qs = wanted ? `?venture=${encodeURIComponent(wanted)}` : "";
        const r = await authFetch(`/api/charles/ventures${qs}`);
        if (!r.ok) throw new Error(`ventures load failed (${r.status})`);
        const json = (await r.json()) as VenturesPayload;
        if (cancelled) return;
        setData(json);
        setError(null);
        // No slug in the path (bare route or a legacy query link) → rewrite to the canonical permalink.
        if (!slug && json.current) router.replace(`${BASE}/${encodeURIComponent(json.current.slug)}`);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [slug, reloadKey, router]);

  const head = (
    <ScreenHead
      title={data?.current?.name ?? "Ventures"}
      sub={data?.current ? `${data.current.legal_type ? data.current.legal_type + " · " : ""}${data.current.kind}` : undefined}
      action={data && data.ventures.length > 0 ? <ScopeSwitcher ventures={data.ventures} currentId={data.current?.id ?? null} onPick={goTo} onAdd={openCreateTop} /> : undefined}
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
        <Empty icon="ventures" title="No ventures yet" body="A venture is a business or holding. Add one to scope your books, CRM and resources." cta="Add venture" onCta={openCreateTop} />
        {createSheet ? <CreateVentureSheet ventures={[]} defaultParentId={createParent} onClose={() => setCreateSheet(false)} onCreated={onCreated} /> : null}
      </div>
    );
  }

  const current = data.current!;
  const others = data.ventures.filter((v) => v.id !== current.id);
  const activeRes = data.resources.filter((r) => r.status === "active");
  const children = data.ventures.filter((v) => v.parent_id === current.id);
  // Ancestor chain (root → … → parent) for the breadcrumb, walked up parent_id with a cycle guard.
  const byId = new Map(data.ventures.map((v) => [v.id, v] as const));
  const ancestors: Venture[] = [];
  {
    const seen = new Set<string>([current.id]);
    let pid = current.parent_id;
    while (pid && !seen.has(pid)) {
      seen.add(pid);
      const a = byId.get(pid);
      if (!a) break;
      ancestors.unshift(a);
      pid = a.parent_id;
    }
  }

  async function deleteVenture(): Promise<void> {
    setDeleting(true);
    setDelErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures/create?id=${encodeURIComponent(current.id)}`, { method: "DELETE" });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `delete failed (${r.status})`);
      setConfirmDel(false);
      // Leave for a remaining venture; if none, the bare route falls back to the empty state.
      if (others[0]) goTo(others[0].slug);
      else { router.replace(BASE); reload(); }
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="ven-screen" style={{ padding: "var(--s5)" }}>
      {head}

      <div className="ven-layout">
        <div className="ven-main">
          {ancestors.length > 0 ? (
            <nav className="screen-sub" aria-label="Breadcrumb" style={{ marginTop: 0, marginBottom: "var(--s3)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px" }}>
              {ancestors.map((a) => (
                <React.Fragment key={a.id}>
                  <button onClick={() => goTo(a.slug)} style={{ background: "none", border: "none", padding: 0, color: "var(--accent-link)", cursor: "pointer", font: "inherit" }}>{a.name}</button>
                  <span aria-hidden="true" style={{ color: "var(--faint)" }}>›</span>
                </React.Fragment>
              ))}
              <span style={{ color: "var(--text)" }}>{current.name}</span>
            </nav>
          ) : null}
          <div style={{ display: "flex", gap: "var(--s2)", marginBottom: "var(--s3)", flexWrap: "wrap" }}>
            <button
              className="btn btn--ghost"
              onClick={() => {
                const url = `${window.location.origin}${BASE}/${encodeURIComponent(current.slug)}`;
                void navigator.clipboard?.writeText(url);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Icon name="link" cls="i i-sm" />{copied ? "Copied" : "Copy link"}
            </button>
            <button className="btn btn--ghost" onClick={() => setMoveSheet(true)}>Move</button>
          </div>
          <TabBar tab={tab} onSelect={selectTab} />

          {tab === "dashboard" ? (
            <>
              <div className="grid-2">
                <StatTile label="Linked resources" value={activeRes.length} foot={<span className="screen-sub" style={{ marginTop: 0 }}>{activeRes.length === 1 ? "account" : "accounts"} attached</span>} />
                <StatTile
                  label="Identity"
                  value={current.legal_type ? current.legal_type.replace("_", " ") : (current.identity ? "Verified" : "—")}
                  foot={<span className="screen-sub" style={{ marginTop: 0 }}>{current.status === "active" ? "Active" : current.status}</span>}
                />
              </div>

              <ContextCard venture={current} onSaved={reload} />

              <div className="card" style={{ marginTop: 16 }}>
                <div className="card__head">
                  <div className="card__title">Sub-ventures</div>
                  <button className="card__action" onClick={() => openCreateChild(current.id)}>+ Add child</button>
                </div>
                {children.length > 0 ? (
                  <div className="loglist">
                    {children.map((v) => (
                      <button className="logrow" key={v.id} style={{ background: "none", border: "none", borderBottom: "1px solid var(--border)", textAlign: "left", cursor: "pointer", width: "100%" }} onClick={() => goTo(v.slug)}>
                        <span className="logrow__main">
                          <span className="logrow__primary">{v.name}</span>
                          <span className="logrow__meta">{v.legal_type ? v.legal_type + " · " : ""}{v.kind}</span>
                        </span>
                        <Icon name="chevron" cls="i i-sm" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="screen-sub" style={{ padding: "8px 0 16px" }}>No sub-ventures yet — add a sub-venture or holding under {current.name}.</p>
                )}
              </div>

              <p className="screen-sub" style={{ marginTop: 16 }}>
                Cash &amp; pipeline appear here once Books and CRM are connected.
              </p>

              <div className="card ven-danger" style={{ marginTop: 16 }}>
                <div className="card__head"><div className="card__title">Danger zone</div></div>
                {delErr ? <p className="screen-sub" style={{ color: "var(--alert)", marginTop: 0 }}>{delErr}</p> : null}
                {confirmDel ? (
                  <div className="ven-danger__confirm">
                    <span className="screen-sub" style={{ margin: 0 }}>Delete <strong>{current.name}</strong> and its boards, cards &amp; linked assets? This can’t be undone.</span>
                    <div className="ven-danger__actions">
                      <button className="btn btn--ghost" disabled={deleting} onClick={() => { setConfirmDel(false); setDelErr(null); }}>Cancel</button>
                      <button className="btn ven-danger__btn" disabled={deleting} onClick={() => void deleteVenture()}>{deleting ? "Deleting…" : "Delete venture"}</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn btn--ghost ven-danger__trigger" onClick={() => setConfirmDel(true)}>
                    <Icon name="x" cls="i i-sm" />Delete this venture
                  </button>
                )}
              </div>
            </>
          ) : null}

          {tab === "resources" ? (
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
                      <button className="logrow res-row" key={r.id} style={{ background: "none", border: "none", borderBottom: "1px solid var(--border)", textAlign: "left", cursor: "pointer", width: "100%" }} onClick={() => setEditRes(r)} title="Edit or detach">
                        <span className="res-ic"><Icon name={meta.icon} /></span>
                        <span className="logrow__main">
                          <span className="logrow__primary">{r.label || r.external_ref || r.provider}</span>
                          <span className="logrow__meta">{meta.label}{r.external_ref ? ` · ${r.external_ref}` : ""}{r.provider && r.provider !== "manual" ? ` · ${r.provider}` : ""}</span>
                        </span>
                        <span className={"pill pill--" + resTone(r.status)}><span className="pill__dot" />Connected</span>
                        <Icon name="chevron" cls="i i-sm" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {tab === "boards" ? (
            <BoardsPanel key={current.id} scopeKind="venture" scopeId={current.id} basePath={`${BASE}/${current.slug}/boards`} />
          ) : null}

          {tab === "content" ? (
            <ContentTab venture={current} />
          ) : null}

          {tab === "decisions" ? (
            <DecisionsTab key={current.id} venture={current} />
          ) : null}
        </div>

        <aside className="ven-aside">
          <IdentityPanel venture={current} onLinked={reload} />
        </aside>
      </div>

      {sheet ? <AttachSheet ventureId={current.id} onClose={() => setSheet(false)} onAttached={reload} /> : null}
      {editRes ? <EditResourceSheet resource={editRes} onClose={() => setEditRes(null)} onSaved={reload} /> : null}
      {createSheet ? <CreateVentureSheet ventures={data.ventures} defaultParentId={createParent} onClose={() => setCreateSheet(false)} onCreated={onCreated} /> : null}
      {moveSheet ? <MoveVentureSheet ventures={data.ventures} current={current} onClose={() => setMoveSheet(false)} onMoved={() => { setMoveSheet(false); reload(); }} /> : null}
    </div>
  );
}

// ── Move-venture (reparent) bottom sheet ─────────────────────────────────────
// Pick a new parent (or top level). The option list excludes the venture itself and its descendants
// so you can't create a cycle (the API also guards). Mirrors the create sheet's parent picker.
function MoveVentureSheet({ ventures, current, onClose, onMoved }: { ventures: Venture[]; current: Venture; onClose: () => void; onMoved: () => void }): React.ReactElement {
  const [parentId, setParentId] = React.useState<string>(current.parent_id ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Descendant set (incl. self) — invalid parents.
  const blocked = React.useMemo(() => {
    const byParent = new Map<string | null, Venture[]>();
    for (const v of ventures) {
      const k = v.parent_id ?? null;
      (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(v);
    }
    const out = new Set<string>([current.id]);
    const walk = (id: string): void => { for (const c of byParent.get(id) ?? []) { out.add(c.id); walk(c.id); } };
    walk(current.id);
    return out;
  }, [ventures, current.id]);

  const opts = ventureTree(ventures).filter(({ v }) => !blocked.has(v.id));

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`/api/charles/ventures/create`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: current.id, parent_id: parentId || undefined }),
      });
      const j = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `move failed (${r.status})`);
      onMoved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-label="Move venture" onClick={onClose}>
      <div className="sheet sheet-dock" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__grip" />
        <div className="sheet-head">
          <h3>Move {current.name}</h3>
          <button className="sheet-x" aria-label="Close" onClick={onClose}><Icon name="x" cls="i i-sm" /></button>
        </div>
        <div className="sheet-fields">
          <div className="field">
            <label className="field__label" htmlFor="mv-parent">New parent</label>
            <select id="mv-parent" className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">— Top level (no parent)</option>
              {opts.map(({ v, depth }) => (
                <option key={v.id} value={v.id}>{" ".repeat(depth * 2)}{v.name}</option>
              ))}
            </select>
          </div>
          {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p> : null}
          <button className="btn btn--primary btn--block btn--lg" disabled={busy || (parentId || null) === (current.parent_id ?? null)} onClick={() => void submit()}>
            {busy ? "Moving…" : "Move venture"}
          </button>
        </div>
      </div>
    </div>
  );
}
