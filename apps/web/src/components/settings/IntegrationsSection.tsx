// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import * as React from "react";
import Link from "next/link";
import { NavIcon } from "@/components/shell/NavIcon";
import { pluginNav } from "@/plugins/registry.generated";
import type { NavSection } from "@/lib/shell/nav";

/**
 * Integrations grid — list all available integration bundles organized by
 * category. Users can click through to configure credentials.
 */
export function IntegrationsSection(): React.ReactElement {
  const integrations = React.useMemo(() => {
    return pluginNav
      .filter((c) => c.group === "Integrations")
      .flatMap((c) =>
        c.sections.map((s) => ({ ...s, bundle: c.bundle, group: c.group }))
      )
      .sort((a, b) => a.label.localeCompare(b.label));
  }, []);

  if (integrations.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-medium text-foreground">Integrations</h2>
          <p className="text-xs text-muted-foreground">
            Connect external services and data sources.
          </p>
        </header>
        <p className="text-xs text-muted-foreground">
          No integrations available.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-medium text-foreground">Integrations</h2>
        <p className="text-xs text-muted-foreground">
          Connect external services and data sources. Click to configure credentials.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {integrations.map((s) => (
          <Link
            key={s.id}
            href={s.href}
            className="flex flex-col items-center gap-2 rounded-md border border-border p-3 text-center transition-colors hover:bg-muted/50"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted/50">
              <NavIcon name={s.icon} className="h-5 w-5" />
            </div>
            <span className="text-xs font-medium text-foreground">{s.label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
