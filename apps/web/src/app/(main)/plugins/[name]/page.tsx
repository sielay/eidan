// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAuth } from "@/components/providers/auth-provider";
import { getPlugin, type PluginDetail } from "@/lib/api/plugins";
import { cn } from "@/lib/utils";

/**
 * Per-plugin info page. Renders the manifest fields the operator
 * cares about (description, license, authors) plus the plugin's
 * ``README.md`` body. The page is mounted from the sidebar's
 * ``PluginRow`` link.
 */
export default function PluginDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}): React.ReactElement {
  const { config, user, loading } = useAuth();
  const resolved = React.use(params);
  const name = resolved.name;
  const [plugin, setPlugin] = React.useState<PluginDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!config || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getPlugin(name);
        if (cancelled) return;
        setPlugin(data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "failed to load plugin");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, user, name]);

  if (loading || !user) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10 text-sm text-muted-foreground">
        Sign in to view plugin detail.
      </main>
    );
  }

  if (error !== null) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10 text-sm text-red-600">
        {error}
      </main>
    );
  }

  if (plugin === null) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10 text-sm text-muted-foreground">
        Loading…
      </main>
    );
  }

  const tools = plugin.tools ?? [];
  const configKeys = plugin.config_keys ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold">{plugin.display_name}</h1>
          <span className="font-mono text-xs text-muted-foreground">
            v{plugin.version}
          </span>
          <span className="rounded-md border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {plugin.tier}
          </span>
        </div>
        {plugin.description ? (
          <p className="text-sm text-muted-foreground">{plugin.description}</p>
        ) : null}
      </header>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">name</dt>
        <dd className="font-mono">{plugin.package_name ?? plugin.name}</dd>
        {plugin.license ? (
          <>
            <dt className="text-muted-foreground">license</dt>
            <dd>{plugin.license}</dd>
          </>
        ) : null}
        {plugin.authors.length > 0 ? (
          <>
            <dt className="text-muted-foreground">authors</dt>
            <dd>
              {plugin.authors
                .map((a) => (a.email ? `${a.name} <${a.email}>` : a.name))
                .join(", ")}
            </dd>
          </>
        ) : null}
      </dl>

      <section
        className={cn(
          "prose prose-sm max-w-none dark:prose-invert",
          "prose-headings:font-semibold prose-headings:text-foreground",
          "prose-a:text-primary prose-code:font-mono",
        )}
      >
        {plugin.readme ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {plugin.readme}
          </ReactMarkdown>
        ) : (
          <p className="text-sm text-muted-foreground">
            No README ships with this plugin.
          </p>
        )}
      </section>

      {tools.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Tools ({tools.length})
          </h2>
          <ul className="flex flex-col gap-3">
            {tools.map((t) => (
              <li key={t.name} className="rounded-md border border-border p-3">
                <code className="font-mono text-sm font-semibold">{t.name}</code>
                {t.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t.description}
                  </p>
                ) : null}
                {t.input_schema &&
                Object.keys(t.input_schema).length > 0 ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      input schema
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-xs">
                      {JSON.stringify(t.input_schema, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {configKeys.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Config keys
          </h2>
          <p className="text-xs text-muted-foreground">
            Set under{" "}
            <code className="font-mono">extensions.{plugin.name}</code> in{" "}
            <code className="font-mono">matbot.yaml</code>.
          </p>
          <ul className="flex flex-wrap gap-2">
            {configKeys.map((k) => (
              <li key={k}>
                <code className="rounded border border-border px-1.5 py-0.5 font-mono text-xs">
                  {k}
                </code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
