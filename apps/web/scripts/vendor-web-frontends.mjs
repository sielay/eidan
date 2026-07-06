// SPDX-License-Identifier: AGPL-3.0-or-later
// Vendor frontend routes/nav from core plugins into apps/web/src/plugins/<name>/,
// then regenerate registry.generated.ts. Used in CI before typecheck to resolve
// the gitignored plugin UI directories that registry imports.
import { vendorFrontend, writeFrontendRegistry } from "../../../deploy/assemble.mjs";
import { CORE_PLUGINS } from "../../../deploy/manifest.mjs";

const frontends = CORE_PLUGINS.map((name) => vendorFrontend(name)).filter(Boolean);
writeFrontendRegistry(frontends);
console.log(`[vendor-web-frontends] vendored ${frontends.length} plugin UI(s)`);
