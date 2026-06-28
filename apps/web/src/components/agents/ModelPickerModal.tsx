// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import type { ModelMetadata, ModelSize, ModelType } from "@/lib/model-registry";
import { getRecommendedModels } from "@/lib/model-registry";

export function ModelPickerModal({
  models,
  currentModel,
  onSelect,
  onClose,
}: {
  models: ModelMetadata[];
  currentModel: string;
  onSelect: (modelId: string, provider: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [search, setSearch] = React.useState("");
  const [filterProvider, setFilterProvider] = React.useState<string | null>(null);
  const [filterType, setFilterType] = React.useState<ModelType | null>(null);
  const [filterSize, setFilterSize] = React.useState<ModelSize | null>(null);
  const [sortBy, setSortBy] = React.useState<"name" | "price" | "context">("name");

  // Handle Escape key to close modal
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const providers = React.useMemo(() => {
    const set = new Set(models.map((m) => m.provider));
    return Array.from(set).sort();
  }, [models]);

  const types: ModelType[] = ["frontier", "mid-tier", "lightweight"];
  const sizes: ModelSize[] = ["7B", "8B", "14B", "70B", "100B+", "proprietary"];

  const filtered = React.useMemo(() => {
    let result = [...models];

    // Text search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q) ||
          m.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    // Filters
    if (filterProvider) result = result.filter((m) => m.provider === filterProvider);
    if (filterType) result = result.filter((m) => m.type === filterType);
    if (filterSize) result = result.filter((m) => m.size === filterSize);

    // Sort
    result.sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "price") {
        const aPrice = (a.promptPrice ?? 999) + (a.completionPrice ?? 999);
        const bPrice = (b.promptPrice ?? 999) + (b.completionPrice ?? 999);
        return aPrice - bPrice;
      }
      if (sortBy === "context") return (b.contextWindow ?? 0) - (a.contextWindow ?? 0);
      return 0;
    });

    return result;
  }, [models, search, filterProvider, filterType, filterSize, sortBy]);

  const recommended = React.useMemo(() => getRecommendedModels(filtered), [filtered]);
  const others = filtered.filter((m) => !m.recommended);

  const formatPrice = (price: number | undefined): string => {
    if (!price) return "—";
    if (price === 0) return "free";
    return `$${price.toFixed(2)}/M`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="flex h-[90vh] max-h-[90vh] w-[95vw] max-w-4xl flex-col rounded-lg bg-background shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold">Choose a model</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Filters */}
        <div className="border-b border-border px-6 py-4">
          <div className="mb-4">
            <input
              type="text"
              placeholder="Search models, providers, or tags…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
              autoFocus
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <select
              value={filterProvider ?? ""}
              onChange={(e) => setFilterProvider(e.target.value || null)}
              className="rounded border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="">All providers</option>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            <select
              value={filterType ?? ""}
              onChange={(e) => setFilterType((e.target.value as ModelType) || null)}
              className="rounded border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>

            <select
              value={filterSize ?? ""}
              onChange={(e) => setFilterSize((e.target.value as ModelSize) || null)}
              className="rounded border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="">All sizes</option>
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "name" | "price" | "context")}
              className="rounded border border-border bg-background px-2 py-1 text-sm"
            >
              <option value="name">Sort by name</option>
              <option value="price">Sort by price (low to high)</option>
              <option value="context">Sort by context window</option>
            </select>

            {(search || filterProvider || filterType || filterSize) && (
              <button
                onClick={() => {
                  setSearch("");
                  setFilterProvider(null);
                  setFilterType(null);
                  setFilterSize(null);
                }}
                className="rounded border border-border px-2 py-1 text-sm hover:bg-muted"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b border-border bg-muted/50">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Model</th>
                <th className="px-4 py-2 text-left font-medium">Provider</th>
                <th className="px-4 py-2 text-center font-medium">Type</th>
                <th className="px-4 py-2 text-center font-medium">Size</th>
                <th className="px-4 py-2 text-right font-medium">Context</th>
                <th className="px-4 py-2 text-right font-medium">Price</th>
                <th className="px-4 py-2 text-left font-medium">Tags</th>
              </tr>
            </thead>
            <tbody>
              {recommended.length > 0 && (
                <>
                  <tr className="bg-amber-50/30 dark:bg-amber-950/10">
                    <td colSpan={7} className="px-4 py-2 font-medium text-xs text-muted-foreground">
                      ⭐ Recommended
                    </td>
                  </tr>
                  {recommended.map((m) => (
                    <ModelTableRow
                      key={m.id}
                      model={m}
                      isSelected={m.id === currentModel}
                      onSelect={onSelect}
                      onClose={onClose}
                      formatPrice={formatPrice}
                    />
                  ))}
                </>
              )}

              {others.length > 0 && (
                <>
                  {recommended.length > 0 && (
                    <tr className="bg-muted/20">
                      <td colSpan={7} className="px-4 py-2 font-medium text-xs text-muted-foreground">
                        Other models
                      </td>
                    </tr>
                  )}
                  {others.map((m) => (
                    <ModelTableRow
                      key={m.id}
                      model={m}
                      isSelected={m.id === currentModel}
                      onSelect={onSelect}
                      onClose={onClose}
                      formatPrice={formatPrice}
                    />
                  ))}
                </>
              )}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No models match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-6 py-4 text-xs text-muted-foreground">
          Showing {filtered.length} of {models.length} models
        </div>
      </div>
    </div>
  );
}

function ModelTableRow({
  model,
  isSelected,
  onSelect,
  onClose,
  formatPrice,
}: {
  model: ModelMetadata;
  isSelected: boolean;
  onSelect: (modelId: string, provider: string) => void;
  onClose: () => void;
  formatPrice: (price: number | undefined) => string;
}): React.ReactElement {
  const handleClick = () => {
    onSelect(model.id, model.provider.toLowerCase());
    onClose();
  };

  return (
    <tr
      onClick={handleClick}
      className={`cursor-pointer border-b border-border hover:bg-muted/50 ${isSelected ? "bg-blue-50/30 dark:bg-blue-950/20" : ""}`}
    >
      <td className="px-4 py-3">
        <div className="font-medium">{model.name}</div>
        <div className="font-mono text-xs text-muted-foreground">{model.id}</div>
      </td>
      <td className="px-4 py-3 text-sm">{model.provider}</td>
      <td className="px-4 py-3 text-center">
        <span className="inline-block rounded bg-muted px-2 py-1 text-xs font-medium">{model.type}</span>
      </td>
      <td className="px-4 py-3 text-center text-sm">{model.size}</td>
      <td className="px-4 py-3 text-right text-sm">{model.contextWindow ? `${(model.contextWindow / 1000).toFixed(0)}K` : "—"}</td>
      <td className="px-4 py-3 text-right text-xs">
        <div>{formatPrice(model.promptPrice)}</div>
        {model.completionPrice && <div className="text-muted-foreground">{formatPrice(model.completionPrice)}</div>}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {model.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="inline-block rounded bg-blue-100/50 px-1.5 py-0.5 text-xs dark:bg-blue-950/30">
              {tag}
            </span>
          ))}
          {model.tags.length > 2 && <span className="text-xs text-muted-foreground">+{model.tags.length - 2}</span>}
        </div>
      </td>
    </tr>
  );
}
