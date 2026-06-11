// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { Button } from "@/components/ui/button";
import {
  KnowledgeConflictError,
  deleteKnowledgeRow,
  getKnowledgeNeighbours,
  getKnowledgeRow,
  listKnowledge,
  updateKnowledgeRow,
  type KnowledgeDetail,
  type KnowledgeNeighbour,
  type KnowledgeSummary,
} from "@/lib/api/knowledge";
import { cn } from "@/lib/utils";

import { KnowledgeMarkdown } from "./KnowledgeMarkdown";

/**
 * Knowledge browser with markdown preview + inline edit (`docs/014
 * §5`, `docs/017 §8`).
 *
 * Two-pane: left list grouped by skill, right detail panel toggling
 * between a markdown preview (with wikilink resolution per `docs/017
 * §8.2`) and a raw-markdown textarea. Save on Cmd+Enter or via the
 * Save button; 409 surfaces a conflict banner and the row is
 * refetched so the operator can retry against the live state.
 */
export default function KnowledgePage(): React.ReactElement {
  const { config, user, loading } = useAuth();

  const [rows, setRows] = React.useState<KnowledgeSummary[] | null>(null);
  const [selected, setSelected] = React.useState<KnowledgeDetail | null>(null);
  const [neighbours, setNeighbours] = React.useState<KnowledgeNeighbour[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [mode, setMode] = React.useState<"preview" | "edit">("preview");
  const [draft, setDraft] = React.useState<string>("");
  const [saving, setSaving] = React.useState(false);
  const [conflict, setConflict] = React.useState(false);

  React.useEffect(() => {
    if (!config || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await listKnowledge({ limit: 200 });
        if (cancelled) return;
        setRows(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "failed to load knowledge",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, user]);

  const grouped = React.useMemo(() => groupBySkill(rows ?? []), [rows]);

  // slug -> {id, title} index used by the wikilink resolver. Built
  // off the same list payload the left pane reads from so wikilink
  // navigation is purely client-side.
  const slugIndex = React.useMemo(() => {
    const map = new Map<string, { id: string; title: string | null }>();
    for (const row of rows ?? []) {
      if (row.slug) {
        map.set(row.slug, { id: row.id, title: row.title });
      }
    }
    return map;
  }, [rows]);

  const resolveSlug = React.useCallback(
    (slug: string) => slugIndex.get(slug) ?? null,
    [slugIndex],
  );

  const openRow = React.useCallback(
    async (rowId: string): Promise<void> => {
      if (!config) return;
      try {
        const [detail, frontier] = await Promise.all([
          getKnowledgeRow(rowId),
          getKnowledgeNeighbours(rowId, { depth: 1, limit: 20 }),
        ]);
        setSelected(detail);
        setDraft(detail.body);
        setMode("preview");
        setConflict(false);
        setNeighbours(frontier.filter((n) => n.hops > 0));
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "failed to load knowledge row",
        );
      }
    },
    [config],
  );

  const saveDraft = React.useCallback(async (): Promise<void> => {
    if (!selected) return;
    if (draft === selected.body) {
      setMode("preview");
      return;
    }
    setSaving(true);
    try {
      const updated = await updateKnowledgeRow(selected.id, {
        body: draft,
        expected_updated_at: selected.updated_at,
      });
      setSelected(updated);
      setDraft(updated.body);
      setMode("preview");
      setConflict(false);
      setError(null);
      // Refresh the list row's updated_at + title so the left pane
      // and the optimistic-concurrency token stay coherent.
      setRows((current) =>
        current
          ? current.map((row) =>
              row.id === updated.id
                ? {
                    ...row,
                    title: updated.title,
                    skill: updated.skill,
                    updated_at: updated.updated_at,
                  }
                : row,
            )
          : current,
      );
    } catch (err) {
      if (err instanceof KnowledgeConflictError) {
        setConflict(true);
        // Refetch so the operator can see the agent-side edit before
        // re-applying their changes.
        try {
          const fresh = await getKnowledgeRow(selected.id);
          setSelected(fresh);
        } catch {
          // Swallow — the banner is the load-bearing signal.
        }
      } else {
        setError(err instanceof Error ? err.message : "failed to save");
      }
    } finally {
      setSaving(false);
    }
  }, [draft, selected]);

  const deleteSelected = React.useCallback(async (): Promise<void> => {
    if (!selected) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Delete "${selected.title ?? selected.slug ?? "this row"}"? Soft-deleted rows are hidden from the agent and from this browser.`,
      )
    ) {
      return;
    }
    try {
      await deleteKnowledgeRow(selected.id);
      setRows((current) =>
        current ? current.filter((row) => row.id !== selected.id) : current,
      );
      setSelected(null);
      setNeighbours([]);
      setMode("preview");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to delete");
    }
  }, [selected]);

  const onTextareaKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void saveDraft();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(selected?.body ?? "");
      setMode("preview");
    }
  };

  const onOpenSlug = React.useCallback(
    (target: { id: string }) => {
      void openRow(target.id);
    },
    [openRow],
  );

  if (loading || !user) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-10">
        <h1 className="text-xl font-semibold tracking-tight">Knowledge</h1>
        <p className="text-sm text-muted-foreground">
          Sign in to browse your knowledge base.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-4 px-6 py-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Knowledge</h1>
        <span className="text-xs text-muted-foreground">
          {rows ? `${rows.length} row${rows.length === 1 ? "" : "s"}` : ""}
        </span>
      </header>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden md:grid-cols-[1fr_2fr]">
        <aside className="overflow-y-auto rounded-md border border-border bg-background/60 p-3 text-sm">
          {rows === null ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-muted-foreground">
              No knowledge yet. The agent writes rows as you build context;
              they will appear here.
            </p>
          ) : (
            grouped.map(({ skill, items }) => (
              <section key={skill || "(uncategorised)"} className="mb-3">
                <h2 className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {skill || "uncategorised"}
                </h2>
                <ul className="flex flex-col gap-0.5">
                  {items.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => void openRow(row.id)}
                        className={cn(
                          "w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-muted",
                          selected?.id === row.id
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        <span className="text-foreground">
                          {row.title ?? row.slug ?? "(untitled)"}
                        </span>
                        {row.slug ? (
                          <span className="ml-2 font-mono text-[10px] text-muted-foreground/70">
                            {row.slug}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </aside>

        <article className="overflow-y-auto rounded-md border border-border bg-background p-4 text-sm">
          {selected ? (
            <>
              <header className="mb-3 flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <h2 className="text-lg font-semibold">
                    {selected.title ?? selected.slug ?? "(untitled)"}
                  </h2>
                  <span className="text-[11px] text-muted-foreground">
                    {selected.skill ?? "uncategorised"}
                    {selected.slug ? ` · ${selected.slug}` : ""}
                    {selected.source ? ` · source: ${selected.source}` : ""}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {mode === "preview" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setMode("edit")}
                    >
                      Edit
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setDraft(selected.body);
                          setMode("preview");
                          setConflict(false);
                        }}
                        disabled={saving}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void saveDraft()}
                        disabled={saving || draft === selected.body}
                      >
                        {saving ? "Saving…" : "Save"}
                      </Button>
                    </>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void deleteSelected()}
                    className="text-red-600 hover:bg-red-50 hover:text-red-700"
                  >
                    Delete
                  </Button>
                </div>
              </header>

              {conflict ? (
                <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                  This row was edited elsewhere since you opened it. The
                  panel was refreshed with the live version — re-apply
                  your changes and save again.
                </p>
              ) : null}

              {mode === "edit" ? (
                <textarea
                  className="h-[60vh] w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => void saveDraft()}
                  onKeyDown={onTextareaKeyDown}
                  spellCheck={false}
                  placeholder="Markdown body. ⌘/Ctrl + Enter to save, Esc to cancel."
                />
              ) : (
                <KnowledgeMarkdown
                  body={selected.body}
                  resolveSlug={resolveSlug}
                  onOpenSlug={onOpenSlug}
                />
              )}

              {neighbours.length > 0 ? (
                <section className="mt-6 border-t border-border pt-3">
                  <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Linked from / links to
                  </h3>
                  <ul className="flex flex-col gap-0.5 text-xs">
                    {neighbours.map((n) => (
                      <li
                        key={n.id}
                        className="flex items-baseline gap-2 text-muted-foreground"
                      >
                        <span className="font-mono text-[10px] text-muted-foreground/70">
                          {n.hops === 1 ? "·" : `+${n.hops}`}
                        </span>
                        <button
                          type="button"
                          className="text-left text-foreground hover:underline"
                          onClick={() => void openRow(n.id)}
                        >
                          {n.title ?? n.slug ?? n.id}
                        </button>
                        {n.slug && n.title ? (
                          <span className="font-mono text-[10px] text-muted-foreground/70">
                            {n.slug}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">
              Select a knowledge row on the left to preview.
            </p>
          )}
        </article>
      </div>
    </div>
  );
}

function groupBySkill(
  rows: KnowledgeSummary[],
): { skill: string | null; items: KnowledgeSummary[] }[] {
  const buckets = new Map<string | null, KnowledgeSummary[]>();
  for (const row of rows) {
    const key = row.skill ?? null;
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  }
  const keys: (string | null)[] = Array.from(buckets.keys()).sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  });
  return keys.map((skill) => ({
    skill,
    items: (buckets.get(skill) ?? []).slice().sort((a, b) => {
      const ta = (a.title ?? a.slug ?? "").toLowerCase();
      const tb = (b.title ?? b.slug ?? "").toLowerCase();
      return ta.localeCompare(tb);
    }),
  }));
}
