// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-call secret resolution over the matbot vault. `${NAME}` resolves the user's vault first,
// then falls back to process.env via the EnvFileVault — the matbot equivalent of the Python
// plugins' `ctx.secret` accessor. Optional lookups swallow MissingSecretError.
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
