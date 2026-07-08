// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

// Content workflow card drawer — the priority screen for the content system.
// CARD DRAWER (content-drawer): title, venture tag, stage, channels; tabs (Chat/Assets/Copy);
// gate strip with advance buttons; right rail (schedule, fork, resources, activity).
// Gates: Idea settled → Assets settled → Copy approved → Schedule → Published (auto).

import * as React from "react";
import { authFetch } from "@/lib/auth";
import { Avatar } from "@/plugins/_shared/Avatar";
import { RichMarkdownEditor } from "@/components/conversation/RichMarkdownEditor";

interface Card { id: string; board_id: string; title: string; body: string | null; status: string; metadata?: Record<string, unknown>; conversation_id?: string | null; parent_card_id?: string | null; channels?: string[]; publish_at?: string | null; frozen_data?: Record<string, unknown>; ref_count?: number; due_date?: string | null; venture_id?: string | null }
interface CardEvent { id: string; kind: string; body: string | null; author_kind?: string; author_id?: string | null; author_label?: string | null; created_at: string }
interface CardAsset { id: string; ref_id: string; ref_kind: string; approval_state: string; metadata?: Record<string, unknown> }
interface CardCopy { id: string; channel: string; body: string | null; state: string }

const CHANNELS = ["linkedin", "x", "bluesky", "threads", "newsletter", "youtube", "shorts", "blog", "pdf"];
const GATES: Record<string, { label: string; nextStage: string }> = {
  concept: { label: "Idea settled", nextStage: "assets" },
  assets: { label: "Assets settled", nextStage: "copy" },
  copy: { label: "Copy approved", nextStage: "distribution" },
  distribution: { label: "Schedule", nextStage: "scheduled" },
};

const S = {
  scrim: { position: "fixed" as const, inset: 0, zIndex: 70, background: "rgba(20,20,30,.36)", display: "flex", justifyContent: "flex-end" },
  drawer: { width: "min(600px, 100%)", height: "100%", overflowY: "auto" as const, background: "var(--bg, #fff)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column" as const },
  head: { padding: "var(--s4)", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s2)" },
  title: { display: "flex", alignItems: "center", gap: "var(--s2)" },
  badge: (color: string) => ({ display: "inline-block", fontSize: "var(--fs-12)", padding: "2px 8px", borderRadius: 999, background: color, color: "#fff" }),
  gateStrip: { padding: "var(--s3) var(--s4)", borderBottom: "1px solid var(--border)", display: "flex", gap: "var(--s2)", alignItems: "center", background: "var(--surface-2, rgba(120,120,140,.04))", flexWrap: "wrap" as const },
  gateDot: (done: boolean) => ({ width: 8, height: 8, borderRadius: 4, background: done ? "var(--good, #0a7)" : "var(--muted)", display: "inline-block" }),
  body: { flex: 1, padding: "var(--s4)", display: "flex", gap: "var(--s4)" },
  tabs: { display: "flex", gap: "var(--s2)", borderBottom: "1px solid var(--border)", marginBottom: "var(--s3)" },
  tab: (active: boolean) => ({ background: "none", border: "none", borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent", color: active ? "var(--text)" : "var(--muted)", padding: "var(--s2)", cursor: "pointer", font: "inherit", fontWeight: active ? 600 : 400, marginBottom: -1 }),
  rail: { flex: "0 0 200px", borderLeft: "1px solid var(--border)", paddingLeft: "var(--s3)", display: "flex", flexDirection: "column" as const, gap: "var(--s3)" },
};

function GateStrip({ card, onAdvance }: { card: Card; onAdvance: () => Promise<void> }): React.ReactElement {
  const stages = ["concept", "assets", "copy", "distribution", "scheduled", "published"];
  const idx = stages.indexOf(card.status);
  const gate = GATES[card.status];
  const isFinal = card.status === "published" || card.status === "scheduled";
  const [advancing, setAdvancing] = React.useState(false);

  return (
    <div style={S.gateStrip}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {stages.map((s, i) => (
          <React.Fragment key={s}>
            {i > 0 ? <span style={{ color: "var(--muted)" }}>→</span> : null}
            <span style={{ fontSize: "var(--fs-12)", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={S.gateDot(i < idx)}>●</span>
              <span style={{ color: i === idx ? "var(--text)" : i < idx ? "var(--muted)" : "var(--muted)" }}>{s}</span>
            </span>
          </React.Fragment>
        ))}
      </div>
      {!isFinal && gate ? (
        <button
          className="btn btn--primary"
          style={{ marginLeft: "auto", minWidth: "auto" }}
          disabled={advancing}
          onClick={async () => {
            setAdvancing(true);
            try {
              await onAdvance();
            } finally {
              setAdvancing(false);
            }
          }}
        >
          {gate.label}
        </button>
      ) : card.status === "scheduled" ? (
        <span style={S.badge("var(--info)")}>Runs at {card.publish_at ? new Date(card.publish_at).toLocaleString() : "—"}</span>
      ) : card.status === "published" ? (
        <span style={S.badge("var(--good)")}>Published</span>
      ) : null}
    </div>
  );
}

function ChannelChips({ channels, onToggle }: { channels: string[]; onToggle: (c: string) => void }): React.ReactElement {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
      {CHANNELS.map((ch) => (
        <button
          key={ch}
          onClick={() => onToggle(ch)}
          style={{
            padding: "4px 10px",
            borderRadius: 999,
            border: "1px solid",
            borderColor: channels.includes(ch) ? "var(--accent)" : "var(--border)",
            background: channels.includes(ch) ? "var(--accent)" : "transparent",
            color: channels.includes(ch) ? "#fff" : "var(--text)",
            cursor: "pointer",
            fontSize: "var(--fs-12)",
          }}
        >
          {ch}
        </button>
      ))}
    </div>
  );
}

function AssetsTab({ cardId }: { cardId: string }): React.ReactElement {
  const [assets, setAssets] = React.useState<CardAsset[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [imageErrors, setImageErrors] = React.useState<Record<string, true>>({});
  const [uploading, setUploading] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`/api/content/cards/${cardId}/assets`);
      const j = (await r.json()) as { assets?: CardAsset[] };
      setAssets(j.assets ?? []);
    } finally { setLoading(false); }
  }, [cardId]);

  React.useEffect(() => { void load(); }, [load]);

  const getFileName = (asset: CardAsset): string => {
    return asset.metadata?.fileName ? String(asset.metadata.fileName) : asset.ref_id;
  };

  const getDownloadUrl = (refId: string): string => {
    // Backend validates refId to prevent unauthorized file access
    return `/api/files/${encodeURIComponent(refId)}/download`;
  };

  const getPreviewUrl = (refId: string): string => {
    // Backend validates refId to prevent unauthorized file access
    return `/api/files/${encodeURIComponent(refId)}/preview`;
  };

  const approveAsset = async (assetId: string): Promise<void> => {
    try {
      await authFetch(`/api/content/cards/${cardId}/assets/${assetId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approval_state: "approved" }),
      });
      await load();
    } catch (e) {
      console.error("Failed to approve asset:", e);
    }
  };

  const rejectAsset = async (assetId: string): Promise<void> => {
    try {
      await authFetch(`/api/content/cards/${cardId}/assets/${assetId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approval_state: "rejected" }),
      });
      await load();
    } catch (e) {
      console.error("Failed to reject asset:", e);
    }
  };

  const handleUpload = async (files: FileList): Promise<void> => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        await authFetch(`/api/content/cards/${cardId}/assets/upload`, {
          method: "POST",
          body: fd,
        });
      }
      await load();
    } catch (e) {
      console.error("Upload failed:", e);
    } finally {
      setUploading(false);
    }
  };

  const images = assets.filter((a) => a.ref_kind === "image");
  const files = assets.filter((a) => a.ref_kind !== "image");

  return (
    <div style={{ flex: 1 }}>
      <div className="screen-sub" style={{ fontWeight: 600, marginBottom: "var(--s2)" }}>Generated Images</div>
      {images.length === 0 ? (
        <div style={{ textAlign: "center", padding: "var(--s3)", border: "2px dashed var(--border)", borderRadius: "var(--r-sm)", marginBottom: "var(--s3)" }}>
          <p className="screen-sub" style={{ margin: 0, marginBottom: "var(--s2)" }}>No assets yet</p>
          <div style={{ display: "flex", gap: "var(--s2)", justifyContent: "center" }}>
            <button className="btn btn--ghost">Generate</button>
            <button className="btn btn--ghost">Upload</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "var(--s2)", marginBottom: "var(--s3)" }}>
          {images.map((a) => (
            <div key={a.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--r-sm)", overflow: "hidden" }}>
              {!imageErrors[a.id] ? (
                <img
                  src={getPreviewUrl(a.ref_id)}
                  alt="asset preview"
                  style={{ aspectRatio: "1", width: "100%", objectFit: "cover", background: "var(--surface-2, #f5f5f5)" }}
                  onError={() => setImageErrors((s) => ({ ...s, [a.id]: true }))}
                />
              ) : (
                <div style={{ aspectRatio: "1", background: "var(--surface-2, #f5f5f5)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: "var(--fs-13)" }}>No preview</div>
              )}
              <div style={{ padding: "var(--s2)", display: "flex", gap: "var(--s1)" }}>
                <button
                  className={`btn ${a.approval_state === "approved" ? "btn--primary" : "btn--ghost"}`}
                  onClick={() => void approveAsset(a.id)}
                  style={{ flex: 1 }}
                >
                  ✓
                </button>
                <button className="btn btn--ghost" onClick={() => void rejectAsset(a.id)} style={{ flex: 1 }}>
                  ✗
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ border: "2px dashed var(--border)", borderRadius: "var(--r-sm)", padding: "var(--s3)", textAlign: "center", marginBottom: "var(--s3)" }}>
        <input
          type="file"
          multiple
          onChange={(e) => void handleUpload(e.currentTarget.files ?? new FileList())}
          disabled={uploading}
          style={{ display: "none" }}
          id={`file-input-${cardId}`}
        />
        <label htmlFor={`file-input-${cardId}`} style={{ cursor: uploading ? "not-allowed" : "pointer" }}>
          <p className="screen-sub" style={{ margin: 0, marginBottom: "var(--s2)" }}>Drop files here or browse</p>
          <button className="btn btn--ghost" disabled={uploading} onClick={() => document.getElementById(`file-input-${cardId}`)?.click()}>
            {uploading ? "Uploading…" : "Select files"}
          </button>
        </label>
      </div>

      <div className="screen-sub" style={{ fontWeight: 600, marginBottom: "var(--s2)" }}>Files</div>
      {files.length === 0 ? (
        <p className="screen-sub" style={{ margin: 0 }}>No files yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
          {files.map((a) => (
            <div key={a.id} style={{ padding: "var(--s2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "var(--fs-13)" }}>{getFileName(a)}</span>
              <a
                href={getDownloadUrl(a.ref_id)}
                download
                className="btn btn--ghost"
                style={{ padding: "2px 6px", textDecoration: "none" }}
                title="Download file"
              >
                ↓
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface CopyVarWithResource extends CardCopy {
  linked_resource?: { type: string; label: string } | null;
}

function CopyTab({ cardId, channels }: { cardId: string; channels: string[] }): React.ReactElement {
  const [copies, setCopies] = React.useState<Record<string, CopyVarWithResource>>({});
  const [loading, setLoading] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [linkingResource, setLinkingResource] = React.useState<string | null>(null);
  const [resourceType, setResourceType] = React.useState("pdf");
  const [resourceLabel, setResourceLabel] = React.useState("");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await authFetch(`/api/content/cards/${cardId}/copy`);
      const j = (await r.json()) as { copies?: CopyVarWithResource[] };
      const map: Record<string, CopyVarWithResource> = {};
      for (const c of j.copies ?? []) map[c.channel] = c;
      setCopies(map);
    } finally { setLoading(false); }
  }, [cardId]);

  React.useEffect(() => { void load(); }, [load]);

  const save = async (channel: string, body: string): Promise<void> => {
    try {
      await authFetch(`/api/content/cards/${cardId}/copy`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, body }),
      });
      setEditing(null);
      await load();
    } catch (e) {
      console.error("Failed to save copy:", e);
    }
  };

  const linkResource = async (channel: string): Promise<void> => {
    if (!resourceLabel.trim()) return;
    try {
      await authFetch(`/api/content/cards/${cardId}/copy/${channel}/resource`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: resourceType, label: resourceLabel.trim() }),
      });
      setLinkingResource(null);
      setResourceLabel("");
      await load();
    } catch (e) {
      console.error("Failed to link resource:", e);
    }
  };

  return (
    <div style={{ flex: 1 }}>
      {channels.length === 0 ? (
        <p className="screen-sub">Select channels first.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
          {channels.map((ch) => {
            const copy = copies[ch];
            return (
              <div key={ch} style={{ border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "var(--s2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s2)" }}>
                  <span style={{ fontWeight: 600, fontSize: "var(--fs-13)" }}>{ch}</span>
                  <span className="screen-sub" style={{ margin: 0, fontSize: "var(--fs-12)" }}>{copy?.state ?? "empty"}</span>
                </div>
                {editing === ch ? (
                  <>
                    {/* RichMarkdownEditor sanitizes output to prevent XSS */}
                    <RichMarkdownEditor
                      value={copy?.body ?? ""}
                      onChange={(v) => setCopies((x) => ({ ...x, [ch]: { ...(x[ch] || { id: "new", channel: ch, state: "draft" }), body: v } as CopyVarWithResource }))}
                      minRows={4}
                      placeholder="Write your copy here…"
                    />
                    <div style={{ display: "flex", gap: "var(--s2)", marginTop: "var(--s2)" }}>
                      <button
                        className="btn btn--primary"
                        onClick={() => void save(ch, copy?.body ?? "")}
                      >
                        Save
                      </button>
                      <button className="btn btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p style={{ margin: 0, marginBottom: "var(--s2)", fontSize: "var(--fs-14)" }}>{copy?.body || "(empty)"}</p>
                    <div style={{ display: "flex", gap: "var(--s1)", marginBottom: "var(--s2)" }}>
                      <button className="btn btn--ghost" onClick={() => setEditing(ch)}>
                        Edit
                      </button>
                    </div>
                    {copy?.linked_resource ? (
                      <div style={{ padding: "var(--s1)", background: "var(--surface-2, rgba(120,120,140,.04))", borderRadius: "var(--r-sm)", fontSize: "var(--fs-12)", marginBottom: "var(--s2)" }}>
                        <span style={{ fontWeight: 500 }}>📎 Linked:</span> {copy.linked_resource.label} ({copy.linked_resource.type})
                      </div>
                    ) : null}
                    {linkingResource === ch ? (
                      <div style={{ display: "flex", gap: "var(--s1)" }}>
                        <select className="input" value={resourceType} onChange={(e) => setResourceType(e.target.value)} style={{ flex: 0, minWidth: 80 }}>
                          <option value="pdf">PDF</option>
                          <option value="mailing_list">Mailing List</option>
                          <option value="form">Form</option>
                        </select>
                        <input
                          className="input"
                          placeholder="Resource label…"
                          value={resourceLabel}
                          onChange={(e) => setResourceLabel(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") void linkResource(ch); }}
                          style={{ flex: 1 }}
                        />
                        <button className="btn btn--primary" onClick={() => void linkResource(ch)} style={{ minWidth: 50 }}>Link</button>
                        <button className="btn btn--ghost" onClick={() => { setLinkingResource(null); setResourceLabel(""); }} style={{ minWidth: 50 }}>✕</button>
                      </div>
                    ) : (
                      <button className="btn btn--ghost" style={{ fontSize: "var(--fs-12)" }} onClick={() => setLinkingResource(ch)}>+ Link a resource</button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChatTab({ cardId, conversationId, onConversationCreated }: { cardId: string; conversationId?: string | null; onConversationCreated?: (conversationId: string) => Promise<void> }): React.ReactElement {
  const [creatingConversation, setCreatingConversation] = React.useState(false);

  const createConversation = async (): Promise<void> => {
    setCreatingConversation(true);
    try {
      const r = await authFetch(`/api/content/cards/${cardId}/conversation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (r.ok) {
        const j = (await r.json()) as { conversation_id?: string };
        if (j.conversation_id) {
          await onConversationCreated?.(j.conversation_id);
        }
      }
    } catch (e) {
      console.error("Failed to create conversation:", e);
    } finally {
      setCreatingConversation(false);
    }
  };

  if (conversationId) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "var(--s4)" }}>
        <div style={{ maxWidth: 300 }}>
          <p className="screen-sub" style={{ fontSize: "var(--fs-14)", marginBottom: "var(--s2)" }}>
            This conversation is linked to the card — assets & drafts save here.
          </p>
          <p style={{ fontSize: "var(--fs-13)", color: "var(--muted)", marginBottom: "var(--s3)" }}>
            Full chat UI integration coming soon.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "var(--s4)" }}>
      <div style={{ maxWidth: 300 }}>
        <p className="screen-sub" style={{ fontSize: "var(--fs-14)", marginBottom: "var(--s2)" }}>
          This card doesn't have a linked conversation yet.
        </p>
        <p style={{ fontSize: "var(--fs-13)", color: "var(--muted)", marginBottom: "var(--s3)" }}>
          Create a conversation to brainstorm ideas, generate assets, and draft copy in context.
        </p>
        <button className="btn btn--primary" disabled={creatingConversation} onClick={() => void createConversation()}>
          {creatingConversation ? "Creating…" : "Start conversation"}
        </button>
        <p style={{ fontSize: "var(--fs-11)", color: "var(--muted)", marginTop: "var(--s2)" }}>
          (Full chat UI integration coming soon)
        </p>
      </div>
    </div>
  );
}

function RightRail({ card, channels, forking, onFork, onChanged }: { card: Card; channels: string[]; forking: boolean; onFork: () => Promise<void>; onChanged: () => Promise<void> }): React.ReactElement {
  const [schedule, setSchedule] = React.useState(card.publish_at ? new Date(card.publish_at).toISOString().slice(0, 16) : "");
  const [events, setEvents] = React.useState<CardEvent[]>([]);
  const [eventsLoading, setEventsLoading] = React.useState(false);

  React.useEffect(() => {
    let timeout: NodeJS.Timeout;
    const loadEvents = async () => {
      setEventsLoading(true);
      try {
        const r = await authFetch(`/api/boards/cards/events?card=${encodeURIComponent(card.id)}`);
        const j = (await r.json()) as { events?: CardEvent[] };
        setEvents(j.events ?? []);
      } finally {
        setEventsLoading(false);
      }
    };
    timeout = setTimeout(() => { void loadEvents(); }, 300);
    return () => clearTimeout(timeout);
  }, [card.id]);

  const saveSchedule = async (time: string): Promise<void> => {
    if (!time) return;
    try {
      const dt = new Date(time);
      await authFetch(`/api/content/cards/${card.id}/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publish_at: dt.toISOString(), channels }),
      });
      await onChanged();
    } catch (e) {
      console.error("Schedule save failed:", e);
    }
  };

  const unfreeze = async (): Promise<void> => {
    try {
      await authFetch(`/api/content/cards/${card.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "distribution" }),
      });
      await onChanged();
    } catch (e) {
      console.error("Unfreeze failed:", e);
    }
  };

  const frozenPlan = card.frozen_data?.distribution?.plan ?? null;

  return (
    <div style={S.rail}>
      <div>
        <div className="screen-sub" style={{ fontWeight: 600, margin: 0, marginBottom: "var(--s2)" }}>Schedule</div>
        {card.status === "scheduled" ? (
          <>
            <p style={{ margin: 0, marginBottom: "var(--s2)", fontSize: "var(--fs-13)" }}>When the time is met, the system executes:</p>
            {frozenPlan && Array.isArray(frozenPlan) ? (
              <div style={{ fontSize: "var(--fs-12)", marginBottom: "var(--s2)" }}>
                {frozenPlan.map((item: { channel?: string; action?: string; status?: string }, i: number) => (
                  <div key={i} style={{ padding: "var(--s1)", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{item.action || `Step ${i + 1}`}</span>
                    <span style={{ fontSize: "var(--fs-11)", color: item.status === "complete" ? "var(--good)" : item.status === "failed" ? "var(--alert)" : "var(--muted)" }}>
                      {item.status === "complete" ? "✓" : item.status === "failed" ? "✗" : "⊙"}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <div style={{ display: "flex", gap: "var(--s1)" }}>
              <button className="btn btn--ghost" style={{ flex: 1 }} onClick={() => void saveSchedule(schedule)}>Reschedule</button>
              <button className="btn btn--ghost" style={{ flex: 1 }} onClick={() => void unfreeze()}>Unfreeze</button>
            </div>
          </>
        ) : card.status === "published" ? (
          <>
            <p style={{ margin: 0, marginBottom: "var(--s2)", fontSize: "var(--fs-13)" }}>Executed on {card.publish_at ? new Date(card.publish_at).toLocaleString() : "—"}</p>
            {frozenPlan && Array.isArray(frozenPlan) ? (
              <div style={{ fontSize: "var(--fs-12)" }}>
                {frozenPlan.map((item: { channel?: string; action?: string; status?: string; result?: string }, i: number) => (
                  <div key={i} style={{ padding: "var(--s1)", borderBottom: "1px solid var(--border)", borderLeft: item.status === "complete" ? "3px solid var(--good)" : item.status === "failed" ? "3px solid var(--alert)" : "3px solid var(--muted)", paddingLeft: "calc(var(--s1) - 3px)" }}>
                    <div style={{ fontWeight: 500 }}>{item.action || `Step ${i + 1}`}</div>
                    {item.result ? <div style={{ fontSize: "var(--fs-11)", color: "var(--muted)", marginTop: "2px" }}>{item.result}</div> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : card.status === "distribution" ? (
          <div style={{ display: "flex", gap: "var(--s1)" }}>
            <input type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} style={{ flex: 1, fontSize: "var(--fs-13)" }} />
            <button className="btn btn--ghost" onClick={() => void saveSchedule(schedule)} style={{ minWidth: 40 }}>✓</button>
          </div>
        ) : null}
      </div>

      <div>
        <div className="screen-sub" style={{ fontWeight: 600, margin: 0, marginBottom: "var(--s2)" }}>Linked Resources</div>
        <p className="screen-sub" style={{ margin: 0, fontSize: "var(--fs-12)" }}>Resources are linked per channel in the Copy tab.</p>
      </div>

      <div>
        <div className="screen-sub" style={{ fontWeight: 600, margin: 0, marginBottom: "var(--s2)" }}>Actions</div>
        <button className="btn btn--ghost" style={{ width: "100%", justifyContent: "flex-start", fontSize: "var(--fs-13)" }} disabled={forking} onClick={() => void onFork()}>
          + Fork variant
        </button>
      </div>

      <div>
        <div className="screen-sub" style={{ fontWeight: 600, margin: 0, marginBottom: "var(--s2)" }}>Activity</div>
        {eventsLoading ? (
          <p className="screen-sub" style={{ margin: 0, fontSize: "var(--fs-12)" }}>Loading…</p>
        ) : events.length === 0 ? (
          <p className="screen-sub" style={{ margin: 0, fontSize: "var(--fs-12)" }}>No activity yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s1)", fontSize: "var(--fs-12)", maxHeight: 300, overflowY: "auto" }}>
            {events.map((e) => {
              const author = e.author_label || e.author_kind || "System";
              const description = e.kind === "status" ? `Advanced to ${e.body}` : e.kind === "asset_approved" ? `Approved asset` : e.kind === "asset_rejected" ? `Rejected asset` : e.kind === "comment" ? `Commented` : e.body || e.kind;
              return (
                <div key={e.id} style={{ paddingBottom: "var(--s1)", borderBottom: "1px solid var(--border)" }}>
                  <div style={{ fontWeight: 500 }}>{description}</div>
                  <div style={{ fontSize: "var(--fs-11)", color: "var(--muted)" }}>
                    {author} · {new Date(e.created_at).toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function ContentCardDrawer({ card, onClose, onChanged }: { card: Card; onClose: () => void; onChanged: () => Promise<void> }): React.ReactElement {
  const [tab, setTab] = React.useState<"chat" | "assets" | "copy">("chat");
  const [channels, setChannels] = React.useState<string[]>(card.channels ?? []);
  const [busy, setBusy] = React.useState(false);
  const [forking, setForking] = React.useState(false);
  const [conversationId, setConversationId] = React.useState<string | null | undefined>(card.conversation_id);

  const advanceGate = async (): Promise<void> => {
    if (!GATES[card.status]) return;
    setBusy(true);
    try {
      await authFetch(`/api/content/cards/${card.id}/gate-advance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await onChanged();
    } catch (e) {
      console.error("Failed to advance gate:", e);
    } finally { setBusy(false); }
  };

  const toggleChannel = async (ch: string): Promise<void> => {
    const next = channels.includes(ch) ? channels.filter((x) => x !== ch) : [...channels, ch];
    setChannels(next);
    try {
      await authFetch(`/api/boards/cards/${card.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channels: next }),
      });
    } catch (e) {
      console.error("Failed to update channels:", e);
      setChannels(channels);
    }
  };

  const createFork = async (): Promise<void> => {
    setForking(true);
    try {
      const forkTitle = `${card.title} (variant)`;
      await authFetch(`/api/content/cards/${card.id}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: forkTitle,
          body: card.body,
          channels: channels,
          board_id: card.board_id,
          parent_card_id: card.id,
          status: "concept",
        }),
      });
      await onChanged();
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForking(false);
    }
  };

  const stageColors: Record<string, string> = {
    concept: "var(--muted)",
    assets: "var(--good)",
    copy: "var(--info)",
    distribution: "var(--warn)",
    scheduled: "var(--info)",
    published: "var(--good)",
  };

  return (
    <div style={S.scrim} role="dialog" aria-modal="true" onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <div style={S.title}>
            <span style={{ fontWeight: 600, fontSize: "var(--fs-16)" }}>{card.title}</span>
            <span style={S.badge(stageColors[card.status])}>{card.status}</span>
          </div>
          <button className="btn btn--ghost" onClick={onClose}>Close</button>
        </div>

        <GateStrip card={card} onAdvance={() => void advanceGate()} />

        <div style={{ padding: "var(--s3) var(--s4)" }}>
          <div className="screen-sub" style={{ fontWeight: 600, marginBottom: "var(--s2)" }}>Channels</div>
          <ChannelChips channels={channels} onToggle={toggleChannel} />
        </div>

        <div style={S.tabs}>
          <button style={S.tab(tab === "chat")} onClick={() => setTab("chat")}>Chat</button>
          <button style={S.tab(tab === "assets")} onClick={() => setTab("assets")}>Assets</button>
          <button style={S.tab(tab === "copy")} onClick={() => setTab("copy")}>Copy</button>
        </div>

        <div style={S.body}>
          {tab === "chat" && <ChatTab cardId={card.id} conversationId={conversationId} onConversationCreated={async (newConvId) => { setConversationId(newConvId); await onChanged(); }} />}
          {tab === "assets" && <AssetsTab cardId={card.id} />}
          {tab === "copy" && <CopyTab cardId={card.id} channels={channels} />}
          <RightRail card={card} channels={channels} forking={forking} onFork={createFork} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}
