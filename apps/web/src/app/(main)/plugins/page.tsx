// SPDX-License-Identifier: AGPL-3.0-or-later
import { PluginList } from "@/components/shell/PluginList";

/**
 * Plugins index — the host's read-only list of installed plugins,
 * grouped by tier (`docs/014 §10`). The shell links its "Plugins"
 * section here; per-plugin detail lives at `/plugins/[name]`.
 */
export default function PluginsPage(): React.ReactElement {
  return (
    <div className="content">
      <div className="screen-head">
        <div>
          <h1 className="screen-title">Plugins</h1>
          <div className="screen-sub">Installed on this host</div>
        </div>
      </div>
      <div className="card">
        <PluginList />
      </div>
    </div>
  );
}
