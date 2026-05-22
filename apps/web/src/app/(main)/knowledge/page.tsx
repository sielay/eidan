"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import {
  getKnowledgeNeighbours,
  getKnowledgeRow,
  listKnowledge,
  type KnowledgeDetail,
  type KnowledgeNeighbour,
  type KnowledgeSummary,
} from "@/lib/api/knowledge";
import { cn } from "@/lib/utils";

/**
 * Read-only knowledge browser — `docs/014 §5`.
 *
 * Two-pane layout: left list grouped by skill, right detail panel
 * with the full markdown body. No edit affordance yet; that lands
 * alongside the `docs/017` knowledge-linking writer-side hook.
 *
 * Clicking a row in the left pane fetches the full body lazily so
 * the index payload stays compact.
 */
export default function KnowledgePage(): React.ReactElement {
  const { config, user, loading } = useAuth();

  const [rows, setRows] = React.useState<KnowledgeSummary[] | null>(null);
  const [selected, setSelected] = React.useState<KnowledgeDetail | null>(null);
  const [neighbours, setNeighbours] = React.useState<KnowledgeNeighbour[]>([]);
  const [error, setError] = React.useState<string | null>(null);

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

  const openRow = async (row: KnowledgeSummary): Promise<void> => {
    if (!config) return;
    try {
      const [detail, frontier] = await Promise.all([
        getKnowledgeRow(row.id),
        getKnowledgeNeighbours(row.id, { depth: 1, limit: 20 }),
      ]);
      setSelected(detail);
      // Drop the seed itself from the panel — `hops > 0` is everyone
      // who links *to* or is linked *from* the selected node.
      setNeighbours(frontier.filter((n) => n.hops > 0));
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "failed to load knowledge row",
      );
    }
  };

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
                        onClick={() => void openRow(row)}
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
              <header className="mb-3 flex flex-col gap-1">
                <h2 className="text-lg font-semibold">
                  {selected.title ?? selected.slug ?? "(untitled)"}
                </h2>
                <span className="text-[11px] text-muted-foreground">
                  {selected.skill ?? "uncategorised"}
                  {selected.slug ? ` · ${selected.slug}` : ""}
                  {selected.source ? ` · source: ${selected.source}` : ""}
                </span>
              </header>
              <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground">
                {selected.body}
              </pre>
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
                        <span className="text-foreground">
                          {n.title ?? n.slug ?? n.id}
                        </span>
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
