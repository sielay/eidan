// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import type { OpenRouterModel } from "@/lib/api/admin";

// Friendly labels for the OpenRouter vendor prefixes (a model id is "<vendor>/<model>").
const VENDOR_LABELS: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", google: "Google", "meta-llama": "Meta · Llama",
  deepseek: "DeepSeek", qwen: "Qwen", mistralai: "Mistral", "x-ai": "xAI",
  cohere: "Cohere", perplexity: "Perplexity", microsoft: "Microsoft", nvidia: "NVIDIA",
};
function vendorLabel(v: string): string {
  return VENDOR_LABELS[v] ?? v.charAt(0).toUpperCase() + v.slice(1);
}

// $/M-tokens hint from OpenRouter's per-token prompt price string.
function priceHint(m: OpenRouterModel): string {
  const p = m.prompt == null ? NaN : Number(m.prompt);
  if (p === 0) return "free";
  if (Number.isNaN(p)) return "";
  const perM = p * 1_000_000;
  return `$${perM < 1 ? perM.toFixed(2) : perM.toFixed(1)}/M`;
}

// Two cascading selects: provider/family → that family's models. Stores (provider, model): a catalog
// vendor maps to the `openrouter` base + the full "<vendor>/<model>" slug; "ollama" → a local model;
// blank → the node default. The engine runs any chosen model via a per-turn synthesized profile.
export function VendorModelPicker({ models, provider, model, onChange }: {
  models: OpenRouterModel[];
  provider: string;
  model: string;
  onChange: (provider: string, model: string) => void;
}): React.ReactElement {
  // `vendor` (the chosen family) must be its OWN state, not derived from `model`: choosing a family
  // clears `model` until a specific model is picked, and a model-derived vendor would immediately snap
  // back to "" — making the model dropdown vanish and the choice impossible. Seed from the current
  // model (covers the edit form, which mounts with the agent already loaded), then keep it in sync if
  // an external model implies a different family (never clobber a chosen-family-awaiting-model state).
  const derivedVendor = provider === "ollama" ? "ollama" : model.includes("/") ? (model.split("/")[0] ?? "") : "";
  const [vendor, setVendor] = React.useState(derivedVendor);
  React.useEffect(() => {
    if (derivedVendor && derivedVendor !== vendor) setVendor(derivedVendor);
  }, [derivedVendor]); // eslint-disable-line react-hooks/exhaustive-deps
  const vendors = React.useMemo(() => {
    const set = new Set<string>();
    for (const m of models) { const v = m.id.split("/")[0]; if (v) set.add(v); }
    return [...set].sort();
  }, [models]);
  const vendorModels = React.useMemo(
    () => models.filter((m) => m.id.startsWith(`${vendor}/`)).sort((a, b) => a.id.localeCompare(b.id)),
    [models, vendor],
  );
  return (
    <>
      <select
        value={vendor}
        onChange={(e) => {
          const v = e.target.value;
          setVendor(v);
          if (v === "ollama") onChange("ollama", "");
          else if (v === "") onChange("", "");
          else onChange("openrouter", "");
        }}
        className="min-w-[9rem] rounded border border-border bg-background px-2 py-1 text-sm"
        title="Provider / model family"
      >
        <option value="">node default</option>
        <option value="ollama">Ollama (local)</option>
        {vendors.map((v) => <option key={v} value={v}>{vendorLabel(v)}</option>)}
      </select>
      {vendor === "ollama" ? (
        <input
          value={model} onChange={(e) => onChange("ollama", e.target.value)}
          placeholder="local model (e.g. llama3.2:1b)"
          className="min-w-[12rem] flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      ) : vendor ? (
        <select
          value={model} onChange={(e) => onChange("openrouter", e.target.value)}
          className="min-w-[16rem] flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs"
        >
          <option value="">— pick a {vendorLabel(vendor)} model —</option>
          {vendorModels.map((m) => <option key={m.id} value={m.id}>{`${m.id.split("/").slice(1).join("/")} · ${priceHint(m)}`}</option>)}
          {model && !vendorModels.some((m) => m.id === model) ? <option value={model}>{model}</option> : null}
        </select>
      ) : (
        <span className="flex-1 self-center text-xs text-muted-foreground">uses the node default model</span>
      )}
    </>
  );
}

export function NodeSelect({
  value, onChange, nodes,
}: { value: string; onChange: (v: string) => void; nodes: string[] }): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="min-w-[10rem] rounded border border-border bg-background px-2 py-1 text-sm"
      title="Pin to a node (needed when the provider only exists on one node, e.g. ollama)"
    >
      <option value="">any node</option>
      {nodes.map((n) => <option key={n} value={n}>{n}</option>)}
      {value && !nodes.includes(value) ? <option value={value}>{value}</option> : null}
    </select>
  );
}
