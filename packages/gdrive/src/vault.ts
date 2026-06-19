// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-call secret resolution over the matbot vault — `${NAME}` resolves the user's vault first,
// then process.env via the EnvFileVault (the matbot equivalent of the Python `ctx.secret`).
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

export async function secretOpt(ctx: ToolContext, name: string): Promise<string | undefined> {
  try {
    return await ctx.vault.resolve(`\${${name}}`);
  } catch (exc) {
    if (exc instanceof MissingSecretError) return undefined;
    throw exc;
  }
}
