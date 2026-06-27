// SPDX-License-Identifier: AGPL-3.0-or-later
// CI-only: vendor EVERY plugin frontend into apps/web/src/plugins/<name>/ and regenerate
// registry.generated.ts, so the web app typechecks/builds from a clean checkout.
//
// apps/web/src/plugins/registry.generated.ts is tracked, but the per-bundle mirror dirs it imports
// (apps/web/src/plugins/<name>/) are gitignored — `assemble` vendors them at deploy time. A fresh CI
// checkout has the registry but not the mirrors, so `tsc`/`next build` can't resolve the imports.
// This replays just assemble's web-vendoring step, config-free (every packages/<name> that declares
// `eidan.frontend`), with no eidan.deploy.json or secrets needed.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, vendorFrontend, writeFrontendRegistry } from "../deploy/assemble.mjs";

const pkgsDir = join(ROOT, "packages");
const fronts = [];
for (const name of readdirSync(pkgsDir)) {
  if (!existsSync(join(pkgsDir, name, "package.json"))) continue;
  const f = vendorFrontend(name); // null for logic-only plugins (no eidan.frontend)
  if (f) fronts.push(f);
}
writeFrontendRegistry(fronts);
console.log(`vendored ${fronts.length} frontend(s): ${fronts.map((f) => f.name).join(", ")}`);
