// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

// ctx.vault is matbot's canonical Vault (resolve() returns the secret or throws MissingSecretError). Do
// NOT re-declare it here — an augmentation with a different shape conflicts with the real runtime type.
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
