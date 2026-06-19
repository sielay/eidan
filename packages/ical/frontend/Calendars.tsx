// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

import { authFetch } from "@/lib/auth";

interface Calendar {
  id: string;
  name: string;
  slug: string;
  context: string;
  vault_key: string;
}

export default function Calendars(): React.ReactElement {
  const [cals, setCals] = React.useState<Calendar[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [context, setContext] = React.useState("");
  const [routine, setRoutine] = React.useState("");
  const [savedRoutine, setSavedRoutine] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      const r = await authFetch("/api/ical/calendars");
      if (!r.ok) throw new Error(`load failed (${r.status})`);
      const j = (await r.json()) as { calendars: Calendar[]; routine?: string; timezone?: string };
      setCals(j.calendars);
      setRoutine(j.routine ?? "");
      setSavedRoutine(j.routine ?? "");
      setError(null);
      // Capture the browser's IANA timezone once, so the agent reasons about times in the
      // operator's zone (calendar events, "today", scheduling) instead of the engine's UTC.
      const browserTz =
        typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
      if (browserTz && j.timezone !== browserTz) {
        void authFetch("/api/ical/calendars", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ timezone: browserTz }),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load calendars");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const saveRoutine = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/ical/calendars", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routine: routine.trim() }),
      });
      if (!r.ok) throw new Error(`save failed (${r.status})`);
      setSavedRoutine(routine.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save routine");
    } finally {
      setBusy(false);
    }
  }, [routine]);

  const add = React.useCallback(async () => {
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/ical/calendars", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), context: context.trim() }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `add failed (${r.status})`);
      }
      setName("");
      setUrl("");
      setContext("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to add calendar");
    } finally {
      setBusy(false);
    }
  }, [name, url, context, load]);

  const remove = React.useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch(`/api/ical/calendars?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) throw new Error(`remove failed (${r.status})`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to remove");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const saveContext = React.useCallback(
    async (id: string, ctx: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await authFetch("/api/ical/calendars", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, context: ctx }),
        });
        if (!r.ok) throw new Error(`save failed (${r.status})`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to save");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return (
    <div className="ical">
      <header className="ical__head">
        <h1>Calendars</h1>
        <p>
          Subscribe the agent to your <code>.ics</code> / CalDAV feeds. Each calendar&rsquo;s URL is
          sealed in your vault — never shown back or handed to a model. The context note tells the
          agent what the calendar is for and how to weigh it.
        </p>
      </header>

      {error ? <div className="ical__err">{error}</div> : null}

      <section className="ical__add">
        <h2>Your routine</h2>
        <p className="ical__muted">
          A note on your day shape, constraints, and energy — across all calendars. The agent reads
          this whenever it looks at your calendars, to judge timing and priority.
        </p>
        <textarea
          value={routine}
          onChange={(e) => setRoutine(e.target.value)}
          rows={3}
          placeholder="e.g. School run 8–9 and 3–4. Deep work mornings; low energy after 4pm. Protect Tue/Thu evenings for family."
          disabled={busy}
        />
        {routine.trim() !== savedRoutine.trim() ? (
          <button className="ical__btn" onClick={() => void saveRoutine()} disabled={busy}>
            Save routine
          </button>
        ) : null}
      </section>

      <section className="ical__add">
        <h2>Add a calendar</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" disabled={busy} />
        </label>
        <label>
          Feed URL (.ics / CalDAV)
          <input
            type="password"
            autoComplete="off"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…/calendar.ics"
            disabled={busy}
          />
        </label>
        <label>
          Context
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={2}
            placeholder="My work calendar — meetings I must attend; treat as high priority."
            disabled={busy}
          />
        </label>
        <button
          className="ical__btn"
          onClick={() => void add()}
          disabled={busy || !name.trim() || !url.trim()}
        >
          Add calendar
        </button>
      </section>

      <section className="ical__list">
        {cals === null ? (
          <p className="ical__muted">Loading…</p>
        ) : cals.length === 0 ? (
          <p className="ical__muted">No calendars yet — add one above.</p>
        ) : (
          cals.map((c) => (
            <CalRow
              key={c.id}
              cal={c}
              busy={busy}
              onRemove={() => void remove(c.id)}
              onSaveContext={(ctx) => void saveContext(c.id, ctx)}
            />
          ))
        )}
      </section>
    </div>
  );
}

function CalRow({
  cal,
  busy,
  onRemove,
  onSaveContext,
}: {
  cal: Calendar;
  busy: boolean;
  onRemove: () => void;
  onSaveContext: (ctx: string) => void;
}): React.ReactElement {
  const [ctx, setCtx] = React.useState(cal.context);
  const dirty = ctx.trim() !== cal.context.trim();
  return (
    <div className="ical__row">
      <div className="ical__row-top">
        <strong>{cal.name}</strong>
        <span className="ical__chip">feed set</span>
        <button className="ical__btn ical__btn--quiet" onClick={onRemove} disabled={busy}>
          Remove
        </button>
      </div>
      <textarea
        className="ical__ctx"
        value={ctx}
        onChange={(e) => setCtx(e.target.value)}
        rows={2}
        placeholder="What is this calendar for?"
        disabled={busy}
      />
      {dirty ? (
        <button className="ical__btn" onClick={() => onSaveContext(ctx.trim())} disabled={busy}>
          Save context
        </button>
      ) : null}
    </div>
  );
}
