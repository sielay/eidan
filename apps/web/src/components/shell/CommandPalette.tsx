"use client";

import * as React from "react";

import { useAuth } from "@/components/providers/auth-provider";
import { listCommands, type CommandSummary } from "@/lib/api/commands";
import { cn } from "@/lib/utils";

/**
 * Global Cmd-K command palette — `docs/014 §7`.
 *
 * Cmd / Ctrl-K opens a modal that lists every plugin command the
 * host has registered. Typing fuzzy-filters by name + description;
 * Enter selects, Escape closes. Phase 1's surface is read-only —
 * selecting a command stages a turn (the conversation view focuses
 * on a new turn template) rather than directly dispatching the
 * command. Cross-surface dispatch lands alongside the per-surface
 * adapters (`docs/019`).
 */
export function CommandPalette(): React.ReactElement | null {
  const { config, user } = useAuth();
  const [open, setOpen] = React.useState(false);
  const [commands, setCommands] = React.useState<CommandSummary[]>([]);
  const [filter, setFilter] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Cmd-K / Ctrl-K toggle; Esc dismisses. Bound at the document
  // level so the palette is reachable from anywhere in the shell.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (event.key === "Escape" && open) {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Fetch commands lazily on first open; refresh on subsequent opens
  // so the operator sees a freshly-installed plugin's commands
  // without a page reload.
  React.useEffect(() => {
    if (!open || !config || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listCommands();
        if (cancelled) return;
        setCommands(rows);
      } catch {
        if (cancelled) return;
        setCommands([]);
      }
    })();
    setFilter("");
    setActive(0);
    return () => {
      cancelled = true;
    };
  }, [open, config, user]);

  React.useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const filtered = React.useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => {
      return (
        c.name.toLowerCase().includes(needle)
        || (c.description ?? "").toLowerCase().includes(needle)
      );
    });
  }, [commands, filter]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && filtered[active]) {
      // Phase 1: stash the chosen command in the URL so the
      // conversation view can pre-fill the composer. The actual
      // dispatch lands with the per-surface adapter work.
      const chosen = filtered[active];
      window.location.href = `/?prompt=${encodeURIComponent(
        `/${chosen.name} `,
      )}`;
    }
  };

  if (!user || !open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="w-full max-w-xl rounded-md border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          className="w-full rounded-t-md border-b border-border bg-transparent px-3 py-2 text-sm outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        <ul className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {commands.length === 0
                ? "No plugin commands registered."
                : "No commands match."}
            </li>
          ) : (
            filtered.map((cmd, idx) => (
              <li key={cmd.name}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => {
                    window.location.href = `/?prompt=${encodeURIComponent(
                      `/${cmd.name} `,
                    )}`;
                  }}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs",
                    idx === active
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <span className="font-mono text-sm text-foreground">
                    /{cmd.name}
                    {cmd.plugin ? (
                      <span className="ml-2 font-sans text-[10px] text-muted-foreground/70">
                        {cmd.plugin}
                      </span>
                    ) : null}
                  </span>
                  {cmd.description ? (
                    <span className="text-muted-foreground">
                      {cmd.description}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
        <footer className="flex items-center justify-between border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>↑/↓ navigate · Enter to use · Esc to close</span>
          <span>{filtered.length} of {commands.length}</span>
        </footer>
      </div>
    </div>
  );
}
