// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { CheckSquare, ChevronRight, Cloud, Download, ExternalLink, FilePlus, Folder, FolderPlus, FileText, Image as ImageIcon, ListChecks, RefreshCw, Square, Tag, Trash2, Upload, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { authFetch } from "@/lib/auth";
import { FileScreen } from "@/components/files/FileScreen";

// A folder-navigable explorer over the unified virtual filesystem (plugin_fs, DB-backed) PLUS a live
// "Google Drive" mount. The current folder lives in the URL PATH (/files/<folder>/<sub>, no query
// strings — the house rule), so back/forward and links work; the explorer resolves that path by
// walking levels (GET /api/fs?parent=<id> for local, /api/gdrive/list?folder=<id> for Drive). The
// reserved first segment "drive" enters the Drive mount. Files stream through /api/fs/blob (engine).
const BASE = "/files";
const DRIVE_SEG = "drive"; // reserved first URL segment for the Google Drive mount

type FileSource = "fs" | "artifact" | "gdrive" | "gdrive-mount";

interface Entry {
  id: string;
  source: FileSource;
  kind: "file" | "folder";
  name: string;
  mime: string | null;
  size: number | null;
  tags?: string[];
}
interface Crumb { name: string; segs: string[] }

interface FsNodeDto { id: string; kind: "file" | "folder"; name: string; mime: string | null; size_bytes: number | null; tags?: string[] }
interface ArtifactDto { id: string; filename: string; mime_type: string | null; size_bytes: number | null }
interface DriveEntryDto { id: string; name: string; mime: string | null; kind: "file" | "folder" }

function fileUrl(source: FileSource, id: string): string {
  if (source === "gdrive") return `/api/gdrive/file?id=${encodeURIComponent(id)}`;
  if (source === "artifact") return `/api/artifacts/${encodeURIComponent(id)}`;
  return `/api/fs/blob?id=${encodeURIComponent(id)}`; // engine resolves storage creds from the vault
}

async function openFile(source: FileSource, id: string, filename: string, download: boolean): Promise<void> {
  const r = await authFetch(fileUrl(source, id));
  if (!r.ok) return;
  const url = URL.createObjectURL(await r.blob());
  if (download) {
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  } else {
    window.open(url, "_blank", "noopener");
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fmtSize(n: number | null): string {
  if (n == null || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function isImage(mime: string | null, name: string): boolean {
  return (mime ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
}
function byKindThenName(x: Entry, y: Entry): number {
  return x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === "folder" ? -1 : 1;
}

async function fsList(parentId: string | null): Promise<FsNodeDto[]> {
  const r = await authFetch(`/api/fs${parentId ? `?parent=${encodeURIComponent(parentId)}` : ""}`);
  if (!r.ok) throw new Error(`load failed (${r.status})`);
  return ((await r.json()) as { nodes?: FsNodeDto[] }).nodes ?? [];
}
async function driveList(folderId: string): Promise<DriveEntryDto[]> {
  const r = await authFetch(`/api/gdrive/list?folder=${encodeURIComponent(folderId)}`);
  if (r.status === 501) throw new Error("DRIVE_OFFLINE");
  if (!r.ok) throw new Error(`Drive list failed (${r.status})`);
  return ((await r.json()) as { entries?: DriveEntryDto[] }).entries ?? [];
}

type PreviewKind = "markdown" | "html" | "image" | "text" | "none";
function previewKind(mime: string | null, name: string): PreviewKind {
  const m = (mime ?? "").toLowerCase();
  const n = name.toLowerCase();
  if (m.startsWith("application/vnd.google-apps.")) return "text";
  if (m.includes("markdown") || n.endsWith(".md") || n.endsWith(".markdown")) return "markdown";
  if (m.includes("html") || n.endsWith(".html") || n.endsWith(".htm")) return "html";
  if (isImage(mime, name)) return "image";
  if (m.startsWith("text/") || /(json|xml|csv|tsv|yaml|yml|log|js|ts|tsx|jsx|py|sql|sh|toml|ini|env|css)$/.test(n) || m.includes("json") || m.includes("xml")) return "text";
  return "none";
}

function PreviewModal({ entry, onClose, onDeleted }: { entry: Entry; onClose: () => void; onDeleted: () => void }): React.ReactElement {
  const kind = previewKind(entry.mime, entry.name);
  const [text, setText] = React.useState<string | null>(null);
  const [imgUrl, setImgUrl] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Drive files live in Google Drive (external) — we don't delete those; artifacts (agent output) do.
  const canDelete = entry.source === "artifact";
  const onDelete = async (): Promise<void> => {
    if (typeof window !== "undefined" && !window.confirm(`Delete "${entry.name}"?`)) return;
    setBusy(true);
    try {
      const r = await authFetch(`/api/artifacts/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      if (!r.ok && r.status !== 204) throw new Error(`delete failed (${r.status})`);
      onDeleted();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  React.useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const r = await authFetch(fileUrl(entry.source, entry.id));
        if (!r.ok) throw new Error(`load failed (${r.status})`);
        if (kind === "image") { const u = URL.createObjectURL(await r.blob()); revoke = u; if (!cancelled) setImgUrl(u); }
        else if (kind !== "none") { const t = await r.text(); if (!cancelled) setText(t); }
      } catch (e) { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [entry, kind]);
  return (
    <div className="sheet-scrim" role="dialog" aria-modal="true" aria-label={`Preview ${entry.name}`} onClick={onClose}>
      <div className="card" style={{ width: "min(900px, 94vw)", maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }} onClick={(e) => e.stopPropagation()}>
        <div className="card__head" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--s3)" }}>
          <div className="card__title" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</div>
          <div style={{ display: "flex", gap: "var(--s2)" }}>
            <button className="btn btn--ghost" title="Open in new tab" onClick={() => void openFile(entry.source, entry.id, entry.name, false)}><ExternalLink className="i i-sm" aria-hidden /></button>
            <button className="btn btn--ghost" title="Download" onClick={() => void openFile(entry.source, entry.id, entry.name, true)}><Download className="i i-sm" aria-hidden /></button>
            {canDelete ? <button className="btn btn--ghost" title="Delete" disabled={busy} onClick={() => void onDelete()} style={{ color: "var(--alert)" }}><Trash2 className="i i-sm" aria-hidden /></button> : null}
            <button className="btn btn--ghost" aria-label="Close" onClick={onClose}><X className="i i-sm" aria-hidden /></button>
          </div>
        </div>
        <div style={{ overflow: "auto", padding: "var(--s3)", flex: 1, minHeight: 120 }}>
          {err ? <p className="screen-sub" style={{ color: "var(--alert)" }}>{err}</p>
            : kind === "image" ? (imgUrl ? <img src={imgUrl} alt={entry.name} style={{ maxWidth: "100%", height: "auto", borderRadius: 8 }} /> : <div className="skel" style={{ height: 200 }} />)
            : kind === "html" ? (text == null ? <div className="skel" style={{ height: 300 }} /> : <iframe title={entry.name} sandbox="" srcDoc={text} style={{ width: "100%", height: "70vh", border: "1px solid var(--border)", borderRadius: 8, background: "#fff" }} />)
            : kind === "markdown" ? (text == null ? <div className="skel" style={{ height: 200 }} /> : <div className="md-preview" style={{ lineHeight: 1.6 }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>)
            : kind === "text" ? (text == null ? <div className="skel" style={{ height: 200 }} /> : <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13, margin: 0 }}>{text}</pre>)
            : <p className="screen-sub">No inline preview for this file type. Use Download or Open in new tab.</p>}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceFiles(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname();
  const segments = React.useMemo<string[]>(() => {
    if (!pathname || !pathname.startsWith(BASE)) return [];
    return pathname.slice(BASE.length).split("/").map((s) => s.trim()).filter(Boolean).map(decodeURIComponent);
  }, [pathname]);

  const [entries, setEntries] = React.useState<Entry[] | null>(null);
  const [crumbs, setCrumbs] = React.useState<Crumb[]>([{ name: "Files", segs: [] }]);
  const [folderId, setFolderId] = React.useState<string | null>(null); // current local folder (null=root; undefined-ish in drive)
  const [inDrive, setInDrive] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const [preview, setPreview] = React.useState<Entry | null>(null);
  const [fileEntry, setFileEntry] = React.useState<Entry | null>(null); // terminal path segment is a file → file screen
  const [uploading, setUploading] = React.useState(false);
  const uploadRef = React.useRef<HTMLInputElement | null>(null);

  const toUrl = (segs: string[]): string => BASE + (segs.length ? "/" + segs.map(encodeURIComponent).join("/") : "");
  const navigate = (segs: string[]): void => router.push(toUrl(segs));

  // Resolve the URL path → the current folder's listing by walking levels.
  React.useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    setFileEntry(null);
    void (async () => {
      try {
        const crumbList: Crumb[] = [{ name: "Files", segs: [] }];
        let result: Entry[];
        if (segments[0] === DRIVE_SEG) {
          crumbList.push({ name: "Google Drive", segs: [DRIVE_SEG] });
          let fid = "root";
          for (let i = 1; i < segments.length; i++) {
            const children = await driveList(fid);
            const child = children.find((e) => e.kind === "folder" && e.name === segments[i]);
            if (!child) throw new Error(`no such Drive folder: ${segments[i]}`);
            fid = child.id;
            crumbList.push({ name: segments[i] as string, segs: segments.slice(0, i + 1) });
          }
          result = (await driveList(fid)).map((d) => ({ id: d.id, source: "gdrive" as const, kind: d.kind, name: d.name, mime: d.mime, size: null }));
          result.sort(byKindThenName);
          if (cancelled) return;
          setInDrive(true); setFolderId(null);
        } else {
          let pid: string | null = null;
          let terminalFile: Entry | null = null;
          for (let i = 0; i < segments.length; i++) {
            const children = await fsList(pid);
            const child = children.find((n) => n.kind === "folder" && n.name === segments[i]);
            if (!child) {
              // Not a folder — if it's the LAST segment and a file, open the file screen.
              const f = i === segments.length - 1 ? children.find((n) => n.kind === "file" && n.name === segments[i]) : undefined;
              if (f) {
                terminalFile = { id: f.id, source: "fs", kind: "file", name: f.name, mime: f.mime, size: f.size_bytes };
                crumbList.push({ name: segments[i] as string, segs: segments.slice(0, i + 1) });
                break;
              }
              throw new Error(`no such folder: ${segments[i]}`);
            }
            pid = child.id;
            crumbList.push({ name: segments[i] as string, segs: segments.slice(0, i + 1) });
          }
          if (terminalFile) {
            if (cancelled) return;
            setCrumbs(crumbList); setInDrive(false); setFileEntry(terminalFile); setEntries([]);
            return;
          }
          const nodes = await fsList(pid);
          result = nodes.map((n) => ({ id: n.id, source: "fs" as const, kind: n.kind, name: n.name, mime: n.mime, size: n.size_bytes, tags: n.tags ?? [] }));
          if (pid === null) {
            const aRes = await authFetch("/api/artifacts");
            const arts: ArtifactDto[] = aRes.ok ? (((await aRes.json()) as { files?: ArtifactDto[] }).files ?? []) : [];
            result.push(...arts.map((a) => ({ id: a.id, source: "artifact" as const, kind: "file" as const, name: a.filename, mime: a.mime_type, size: a.size_bytes })));
          }
          result.sort(byKindThenName);
          if (pid === null) result.unshift({ id: "root", source: "gdrive-mount", kind: "folder", name: "Google Drive", mime: null, size: null });
          if (cancelled) return;
          setInDrive(false); setFolderId(pid);
        }
        setCrumbs(crumbList);
        setEntries(result);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg === "DRIVE_OFFLINE" ? "Google Drive isn’t connected — add a Google account with the Drive scope under Settings → Connections." : msg);
        setEntries([]);
      }
    })();
    return () => { cancelled = true; };
  }, [pathname, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const enter = (e: Entry): void => {
    if (e.kind === "folder") {
      if (e.source === "gdrive-mount") navigate([DRIVE_SEG]);
      else navigate([...segments, e.name]);
      return;
    }
    // A local file gets its own URL/screen (view + edit markdown + delete); Drive/artifact files
    // keep the quick popup preview.
    if (e.source === "fs") { navigate([...segments, e.name]); return; }
    setPreview(e);
  };

  const onUpload = React.useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(fileList)) {
        const fd = new FormData();
        fd.append("file", f);
        if (folderId) fd.append("parent_id", folderId);
        await authFetch("/api/fs/file", { method: "POST", body: fd });
      }
      setReload((n) => n + 1);
    } finally {
      setUploading(false);
    }
  }, [folderId]);

  // Create a new (empty) local file in the current folder, then open it in the editor — so you can
  // draft a prompt spec from scratch (the counterpart to editing an existing one). Defaults to .md.
  const [creating, setCreating] = React.useState(false);
  const onCreateFile = React.useCallback(async () => {
    if (creating) return;
    const raw = typeof window !== "undefined" ? window.prompt("New file name", "untitled.md") : null;
    const name = raw?.trim();
    if (!name) return;
    setCreating(true);
    try {
      const mime = /\.(md|markdown)$/i.test(name) ? "text/markdown" : "text/plain";
      const r = await authFetch("/api/fs/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, content: "", mime, ...(folderId ? { parent_id: folderId } : {}) }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `create failed (${r.status})`);
      navigate([...segments, name]); // → the file's own screen, ready to edit
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [creating, folderId, segments]); // eslint-disable-line react-hooks/exhaustive-deps

  // Create a folder in the current folder (the explorer reloads to show it).
  const onCreateFolder = React.useCallback(async () => {
    if (creating) return;
    const raw = typeof window !== "undefined" ? window.prompt("New folder name", "") : null;
    const name = raw?.trim();
    if (!name) return;
    setCreating(true);
    try {
      const r = await authFetch("/api/fs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mkdir", name, ...(folderId ? { parent_id: folderId } : {}) }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `create failed (${r.status})`);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [creating, folderId]);

  // ── Multi-select + bulk delete over local (fs) entries; non-fs rows (Drive/artifacts) aren't selectable ──
  const [selectMode, setSelectMode] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const exitSelect = React.useCallback(() => { setSelectMode(false); setSelected(new Set()); }, []);
  React.useEffect(() => { exitSelect(); }, [pathname, exitSelect]); // a navigation drops any stale selection
  const toggleSelect = React.useCallback((id: string) => {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  // Deletable in bulk: local fs entries AND agent artifacts (each routes to its own delete endpoint).
  const DELETABLE = React.useMemo(() => new Set<FileSource>(["fs", "artifact"]), []);
  const selectableIds = React.useMemo(() => (entries ?? []).filter((e) => DELETABLE.has(e.source)).map((e) => e.id), [entries, DELETABLE]);
  const bulkTag = React.useCallback(async () => {
    if (selected.size === 0 || bulkBusy) return;
    const raw = typeof window !== "undefined" ? window.prompt(`Add a label to ${selected.size} item${selected.size === 1 ? "" : "s"}`) : null;
    const tag = raw?.trim();
    if (!tag) return;
    // Only fs nodes carry tags (artifacts/Drive don't); tag the fs ids in the selection.
    const ids = Array.from(selected).filter((id) => (entries ?? []).some((e) => e.id === id && e.source === "fs"));
    if (!ids.length) { setError("Only local files/folders can be labelled."); return; }
    setBulkBusy(true);
    try {
      const r = await authFetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "tag", ids, add: [tag] }) });
      if (!r.ok) throw new Error(String(r.status));
      exitSelect();
      setReload((n) => n + 1);
    } catch { setError("Couldn't apply the label — try again."); } finally { setBulkBusy(false); }
  }, [selected, bulkBusy, exitSelect, entries]);
  const bulkDelete = React.useCallback(async () => {
    if (selected.size === 0 || bulkBusy) return;
    if (typeof window !== "undefined" && !window.confirm(`Delete ${selected.size} item${selected.size === 1 ? "" : "s"}? Folders are removed with all their contents (recoverable from the archive).`)) return;
    setBulkBusy(true);
    const ids = Array.from(selected);
    const sourceOf = new Map((entries ?? []).map((e) => [e.id, e.source]));
    const results = await Promise.allSettled(ids.map((id) => {
      const url = sourceOf.get(id) === "artifact" ? `/api/artifacts/${encodeURIComponent(id)}` : `/api/fs?id=${encodeURIComponent(id)}`;
      return authFetch(url, { method: "DELETE" }).then((r) => { if (!r.ok && r.status !== 204) throw new Error(String(r.status)); });
    }));
    const failed = results.filter((r) => r.status === "rejected").length;
    setBulkBusy(false);
    exitSelect();
    if (failed > 0) setError(`${failed} item${failed === 1 ? "" : "s"} couldn't be deleted — try again.`);
    setReload((n) => n + 1);
  }, [selected, bulkBusy, exitSelect, entries]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--s3)", marginBottom: "var(--s3)" }}>
        <nav className="screen-sub" aria-label="Breadcrumb" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, margin: 0 }}>
          {crumbs.map((c, i) => (
            <React.Fragment key={`${c.segs.join("/")}-${i}`}>
              {i > 0 ? <ChevronRight className="i i-sm" aria-hidden style={{ color: "var(--faint)" }} /> : null}
              {i < crumbs.length - 1 ? (
                <button onClick={() => navigate(c.segs)} style={{ background: "none", border: "none", padding: 0, color: "var(--accent-link)", cursor: "pointer", font: "inherit" }}>{c.name}</button>
              ) : (
                <span style={{ color: "var(--text)" }}>{c.name}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
        <div style={{ display: "flex", gap: "var(--s2)" }}>
          <button className="btn btn--ghost" title="Refresh" aria-label="Refresh" onClick={() => setReload((n) => n + 1)}><RefreshCw className="i i-sm" aria-hidden /></button>
          {!inDrive && !fileEntry ? (
            <>
              <input ref={uploadRef} type="file" multiple hidden onChange={(e) => { void onUpload(e.target.files); e.target.value = ""; }} />
              <button className="btn btn--ghost" disabled={creating} title="Create a new file and edit it" onClick={() => void onCreateFile()}><FilePlus className="i i-sm" aria-hidden /> {creating ? "Creating…" : "New file"}</button>
              <button className="btn btn--ghost" disabled={creating} title="Create a new folder" onClick={() => void onCreateFolder()}><FolderPlus className="i i-sm" aria-hidden /> New folder</button>
              <button className="btn btn--ghost" disabled={uploading} onClick={() => uploadRef.current?.click()}><Upload className="i i-sm" aria-hidden /> {uploading ? "Uploading…" : "Upload"}</button>
              {(entries?.some((e) => DELETABLE.has(e.source))) ? (
                <button className="btn btn--ghost" title="Select multiple to delete in bulk" onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}>
                  <ListChecks className="i i-sm" aria-hidden /> {selectMode ? "Done" : "Select"}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {fileEntry ? (
        <FileScreen entry={fileEntry} onBack={() => navigate(segments.slice(0, -1))} onDeleted={() => navigate(segments.slice(0, -1))} />
      ) : error && (!entries || entries.length === 0) ? (
        <div className="card" style={{ borderColor: "var(--alert)" }}>
          <div className="card__title">{inDrive ? "Google Drive" : "Couldn’t load files"}</div>
          <p className="screen-sub">{error}</p>
        </div>
      ) : !entries ? (
        <div className="skel" style={{ height: 160 }} />
      ) : entries.length === 0 ? (
        <div className="empty">
          <span className="empty__icon"><Folder className="i" aria-hidden /></span>
          <div className="empty__title">Empty folder</div>
          <div className="empty__body">Files the agent writes (and anything you upload) appear here.</div>
        </div>
      ) : (
        <>
          {selectMode ? (
            <div className="card" style={{ display: "flex", alignItems: "center", gap: "var(--s3)", padding: "8px 12px", marginBottom: "var(--s2)" }}>
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{selected.size} selected</span>
              <button className="btn btn--ghost btn--sm" onClick={() => setSelected(new Set(selectableIds))}>All</button>
              <span style={{ flex: 1 }} />
              <button className="btn btn--ghost btn--sm" disabled={selected.size === 0 || bulkBusy} onClick={() => void bulkTag()}>
                <Tag className="i i-sm" aria-hidden /> Tag
              </button>
              <button className="btn btn--ghost btn--sm" disabled={selected.size === 0 || bulkBusy} onClick={() => void bulkDelete()} style={{ color: "var(--alert)" }}>
                <Trash2 className="i i-sm" aria-hidden /> {bulkBusy ? "Deleting…" : "Delete"}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={exitSelect}><X className="i i-sm" aria-hidden /> Cancel</button>
            </div>
          ) : null}
          <div className="card" style={{ padding: 0 }}>
            <div className="loglist">
              {entries.map((e) => {
                const Icon = e.source === "gdrive-mount" ? Cloud : e.kind === "folder" ? Folder : isImage(e.mime, e.name) ? ImageIcon : FileText;
                const selectable = selectMode && DELETABLE.has(e.source);
                const checked = selected.has(e.id);
                return (
                  <div key={`${e.source}:${e.id}`} className="fs-row" style={{ display: "flex", alignItems: "center", gap: "var(--s3)", borderBottom: "1px solid var(--border)", padding: "8px 12px", opacity: selectMode && !selectable ? 0.5 : 1 }}>
                    {selectable ? (
                      <button onClick={() => toggleSelect(e.id)} aria-label={checked ? `Deselect ${e.name}` : `Select ${e.name}`} role="checkbox" aria-checked={checked} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "flex", flexShrink: 0 }}>
                        {checked ? <CheckSquare className="i i-sm" aria-hidden style={{ color: "var(--accent)" }} /> : <Square className="i i-sm" aria-hidden style={{ color: "var(--faint)" }} />}
                      </button>
                    ) : null}
                    <button onClick={() => (selectable ? toggleSelect(e.id) : enter(e))} title={selectable ? (checked ? "Deselect" : "Select") : e.kind === "folder" ? "Open" : "Preview"} style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: "var(--s3)", minWidth: 0, flex: 1 }}>
                      <Icon className="i i-sm" aria-hidden style={{ color: e.kind === "folder" ? "var(--accent)" : "var(--faint)", flexShrink: 0 }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                    </button>
                    {e.tags && e.tags.length ? (
                      <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                        {e.tags.slice(0, 3).map((t) => (
                          <span key={t} title={t} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "0 6px", borderRadius: 999, background: "var(--accent-soft, rgba(99,102,241,0.14))", color: "var(--accent-link, #4f46e5)", fontSize: 11, fontWeight: 500 }}><Tag className="i" style={{ width: 10, height: 10 }} aria-hidden />{t}</span>
                        ))}
                      </span>
                    ) : null}
                    <span className="screen-sub" style={{ margin: 0, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{e.kind === "file" ? fmtSize(e.size) : ""}</span>
                    {selectMode ? null : e.kind === "file" ? (
                      <button className="btn btn--ghost btn--sm" title="Download" aria-label={`Download ${e.name}`} onClick={() => void openFile(e.source, e.id, e.name, true)} style={{ flexShrink: 0 }}><Download className="i i-sm" aria-hidden /></button>
                    ) : (
                      <ChevronRight className="i i-sm" aria-hidden style={{ color: "var(--faint)", flexShrink: 0 }} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      {preview ? <PreviewModal entry={preview} onClose={() => setPreview(null)} onDeleted={() => { setPreview(null); setReload((n) => n + 1); }} /> : null}
    </>
  );
}
