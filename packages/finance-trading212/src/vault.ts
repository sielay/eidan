// SPDX-License-Identifier: AGPL-3.0-or-later
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

export async function secretRequired(ctx: ToolContext, name: string): Promise<string> {
  const value = await secretOpt(ctx, name);
  if (!value) {
    throw new Error(`Missing secret: ${name}`);
  }
  return value;
}
