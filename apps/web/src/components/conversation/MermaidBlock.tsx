// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";

// Render a ```mermaid fenced block as an SVG diagram. mermaid is a heavy dependency, so it's
// lazy-loaded on first use (shared promise; initialised once). A render error falls back to the raw
// source so a malformed diagram never blanks the message. securityLevel 'strict' sanitises the SVG.
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
      return m.default;
    });
  }
  return mermaidPromise;
}

let seq = 0;
export function MermaidBlock({ code }: { code: string }): React.ReactElement {
  const [svg, setSvg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const id = `mermaid-${++seq}`;
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        const out = await mermaid.render(id, code.trim());
        if (!cancelled) { setSvg(out.svg); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (err) return <pre className="msg-mermaid-err" title={err}>{code}</pre>;
  if (svg == null) return <div className="skel" style={{ height: 80, borderRadius: 8 }} aria-label="rendering diagram" />;
  return <div className="msg-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
