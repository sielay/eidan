// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

export async function getSecret(ctx: ToolContext, name: string, required = false): Promise<string | undefined> {
  try {
    return await ctx.vault.resolve(`\${${name}}`);
  } catch (exc) {
    if (exc instanceof MissingSecretError) {
      if (required) throw new Error(`Required secret not found: ${name}`);
      return undefined;
    }
    throw exc;
  }
}
