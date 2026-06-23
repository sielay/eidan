// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-call secret resolution over the matbot vault. `${NAME}` resolves the user's encrypted vault
// first, then falls back to process.env via the EnvFileVault — the matbot equivalent of the Python
// plugins' `ctx.secret` accessor. Optional lookups swallow MissingSecretError. Copied verbatim from
// the eidan mail integration so every eidan plugin reads secrets the same way.
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

export async function secret(ctx: ToolContext, name: string): Promise<string> {
  return ctx.vault.resolve(`\${${name}}`);
}

export async function secretOpt(ctx: ToolContext, name: string): Promise<string | undefined> {
  try {
    return await secret(ctx, name);
  } catch (exc) {
    if (exc instanceof MissingSecretError) return undefined;
    throw exc;
  }
}
