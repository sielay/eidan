// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Play,
  Trash2,
  Clock,
} from "lucide-react";

import { authFetch } from "@/lib/auth";

interface Procedure {
  name: string;
  preview: string;
  last_run_at?: string | null;
  schedule?: string;
}

interface ProcedureDetail {
  id: string;
  name: string;
  source: string;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  history: ExecutionResult[];
}

interface ExecutionResult {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result: unknown;
  error: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}

async function callTool(tool: string, input: unknown): Promise<unknown> {
  const res = await authFetch(`/api/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`tool call failed: ${res.statusText}`);
  const data = await res.json() as { type: string; value?: unknown; message?: string };
  if (data.type === 'error') throw new Error(data.message ?? 'unknown error');
  return data.value;
}

async function loadProcedures(): Promise<Procedure[]> {
  try {
    const result = await callTool('procedures_action', { action: 'list' });
    const r = result as { procedures: Procedure[] };
    return r.procedures;
  } catch {
    return [];
  }
}

async function loadProcedure(name: string): Promise<ProcedureDetail | null> {
  try {
    const result = await callTool('procedures_action', { action: 'get', name });
    return result as ProcedureDetail;
  } catch {
    return null;
  }
}

async function deleteProcedure(name: string): Promise<boolean> {
  try {
    await callTool('procedures_action', { action: 'delete', name });
    return true;
  } catch {
    return false;
  }
}

async function runProcedure(name: string): Promise<{ execution_id: string; status: string }> {
  try {
    const result = await callTool('procedures_action', { action: 'run', name });
    return result as { execution_id: string; status: string };
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'run failed');
  }
}

export function ProceduresScreen(): React.ReactElement {
  const [procedures, setProcedures] = React.useState<Procedure[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<ProcedureDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [running, setRunning] = React.useState(false);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const procs = await loadProcedures();
      setProcedures(procs);
      if (selected) {
        const d = await loadProcedure(selected);
        setDetail(d);
      }
    } finally {
      setLoading(false);
    }
  }, [selected]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const handleSelect = React.useCallback(async (name: string) => {
    setSelected(name);
    const d = await loadProcedure(name);
    setDetail(d);
  }, []);

  const handleDelete = React.useCallback(async () => {
    if (!selected) return;
    if (!confirm(`Delete procedure "${selected}"?`)) return;
    setLoading(true);
    try {
      await deleteProcedure(selected);
      setSelected(null);
      setDetail(null);
      await reload();
    } finally {
      setLoading(false);
    }
  }, [selected, reload]);

  const handleRun = React.useCallback(async () => {
    if (!selected) return;
    setRunning(true);
    try {
      const result = await runProcedure(selected);
      alert(`Procedure executed: ${result.status}\nExecution ID: ${result.execution_id}`);
      await reload();
    } catch (e) {
      alert(`Failed to run: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setRunning(false);
    }
  }, [selected, reload]);

  const handleCopySource = React.useCallback(() => {
    if (!detail) return;
    navigator.clipboard.writeText(detail.source);
  }, [detail]);

  if (selected && detail) {
    return (
      <div className="content">
        <div className="mem-detail">
          <div className="mem-detail__bar">
            <button type="button" className="iconbtn mem-backbtn" onClick={() => setSelected(null)}>
              <ChevronLeft className="i-sm" aria-hidden />
              Procedures
            </button>
            <div className="erow" style={{ gap: 8 }}>
              <button
                type="button"
                className="iconbtn"
                onClick={handleRun}
                disabled={running || loading}
                title="Run this procedure"
              >
                <Play className="i-sm" aria-hidden />
                Run
              </button>
              <button type="button" className="iconbtn" onClick={handleCopySource} title="Copy source code">
                <Copy className="i-sm" aria-hidden />
              </button>
              <button
                type="button"
                className="iconbtn"
                onClick={handleDelete}
                disabled={loading}
                title="Delete procedure"
              >
                <Trash2 className="i-sm" aria-hidden />
              </button>
            </div>
          </div>

          <h1 className="mem-detail__title">{detail.name}</h1>
          {detail.last_run_at && (
            <div style={{ marginBottom: "var(--s3)", fontSize: "0.875rem", color: "var(--fg-dim)" }}>
              Last run: {new Date(detail.last_run_at).toLocaleString()}
            </div>
          )}

          <div style={{ marginBottom: "var(--s4)" }}>
            <h2 style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: "var(--s2)" }}>Source Code</h2>
            <pre style={{
              background: "var(--bg-muted)",
              padding: "var(--s3)",
              borderRadius: "var(--radius)",
              overflow: "auto",
              fontSize: "0.75rem",
              fontFamily: "monospace",
              maxHeight: "400px",
            }}>
              {detail.source}
            </pre>
          </div>

          {detail.history && detail.history.length > 0 && (
            <div>
              <h2 style={{ fontSize: "0.875rem", fontWeight: 600, marginBottom: "var(--s2)" }}>Execution History</h2>
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--s2)" }}>
                {detail.history.map((exec) => (
                  <div key={exec.id} style={{
                    background: "var(--bg-muted)",
                    padding: "var(--s2)",
                    borderRadius: "var(--radius)",
                    fontSize: "0.75rem",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", marginBottom: "var(--s1)" }}>
                      <Clock className="i-xs" aria-hidden style={{ color: "var(--fg-dim)" }} />
                      <span>{new Date(exec.started_at).toLocaleString()}</span>
                      <span style={{
                        padding: "2px 6px",
                        borderRadius: "3px",
                        fontSize: "0.65rem",
                        fontFamily: "monospace",
                        fontWeight: 500,
                        background: exec.status === 'completed'
                          ? 'rgba(34, 197, 94, 0.1)'
                          : exec.status === 'failed'
                            ? 'rgba(239, 68, 68, 0.1)'
                            : 'rgba(59, 130, 246, 0.1)',
                        color: exec.status === 'completed'
                          ? 'rgb(22, 101, 52)'
                          : exec.status === 'failed'
                            ? 'rgb(127, 29, 29)'
                            : 'rgb(30, 58, 138)',
                      }}>
                        {exec.status}
                      </span>
                      {exec.duration_ms && (
                        <span style={{ color: "var(--fg-dim)", marginLeft: "auto" }}>{exec.duration_ms}ms</span>
                      )}
                    </div>
                    {exec.error && (
                      <div style={{ color: "rgb(220, 38, 38)", fontSize: "0.65rem", marginBottom: "var(--s1)" }}>
                        {exec.error}
                      </div>
                    )}
                    {exec.result != null ? (
                      <div style={{
                        fontSize: "0.65rem",
                        fontFamily: "monospace",
                        whiteSpace: "pre-wrap",
                        overflow: "auto",
                        maxHeight: "150px",
                      }}>
                        {JSON.stringify(exec.result, null, 2)}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="content">
      <div className="screen-head">
        <h1 className="screen-title">Procedures</h1>
      </div>

      <div className="card card--flat" style={{ padding: "var(--s4)" }}>
        {loading && procedures.length === 0 ? (
          <div className="empty">
            <div className="empty__body">Loading procedures...</div>
          </div>
        ) : procedures.length === 0 ? (
          <div className="empty">
            <div className="empty__body">No procedures yet.</div>
            <div style={{ fontSize: "0.875rem", color: "var(--fg-dim)", marginTop: "var(--s2)" }}>
              Create one in chat with the procedures tool.
            </div>
          </div>
        ) : (
          <div className="mem-list">
            {procedures.map((proc) => (
              <button
                key={proc.name}
                type="button"
                className="mem-row"
                onClick={() => handleSelect(proc.name)}
              >
                <span className="mem-row__main">
                  <span className="mem-row__title">{proc.name}</span>
                  <span className="mem-row__snip">{proc.preview}</span>
                </span>
                <ChevronRight className="i-sm mem-chev" aria-hidden />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
