// SPDX-License-Identifier: AGPL-3.0-or-later
// brand_kit — get/set the per-scope brand kit (voice, visual style, language rules, reference images).
// The brand kit is layered into every content generation (image + copy) so output stays on-brand and
// the model doesn't drift or invent a voice. `composeBrandBlock` is the pure fragment that generative
// stages prepend to their prompt.
import type { JSONSchema, Tool } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';

import type { ContentDb, BrandPatch } from './db.js';
import type { BrandFields } from './scope.js';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// Resolve the effective (cascaded) brand block for a scope — what a generative stage should prepend.
// This is the grounding entry point for generation: default → venture ancestry → channel, merged.
export async function resolveBrandBlock(db: ContentDb, scope: string): Promise<string> {
  const resolved = await db.resolveBrand(scope);
  return composeBrandBlock(resolved.effective);
}

// Turn a brand kit into the prompt fragment a generative stage prepends. Empty fields are omitted, so
// a sparse kit yields a sparse block (no "Voice: null" noise). Pure — unit-tested.
export function composeBrandBlock(kit: BrandFields | null): string {
  if (!kit) return '';
  const lines: string[] = [];
  if (kit.voice && kit.voice.trim()) lines.push(`Voice & tone: ${kit.voice.trim()}`);
  if (kit.styleguide && kit.styleguide.trim()) lines.push(`Visual style: ${kit.styleguide.trim()}`);
  if (kit.language && kit.language.trim()) lines.push(`Language rules: ${kit.language.trim()}`);
  if (kit.brand_assets?.length) {
    // Typed assets — name each by its role so the model can pick the right one ("use the Bluesky banner").
    const byRole = kit.brand_assets.map((a) => `${a.role || 'asset'} (id ${a.id})`).join('; ');
    lines.push(`Brand assets: ${byRole}. Use the one matching the channel/purpose when generating or attaching.`);
  } else if (kit.reference_images.length) {
    lines.push(`Reference images: ${kit.reference_images.length} attached (honour their look).`);
  }
  if (!lines.length) return '';
  return ['[BRAND KIT — keep everything on-brand]', ...lines].join('\n');
}

type BrandInput =
  | { action: 'get'; scope?: string }
  | { action: 'set'; scope?: string; voice?: string; styleguide?: string; language?: string; reference_images?: string[] }
  | { action: 'list' };

export function buildBrandTool(db: ContentDb): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'list'], description: 'get | set | list' },
      scope: { type: 'string', description: "Brand scope: 'default' (house style), 'venture:<id>' (a venture's brand), or 'venture:<id>:<channel>' (a channel sub-brand, e.g. venture:<id>:instagram). get resolves the full cascade (default → venture ancestry → channel); set writes the exact scope. Defaults to 'default'." },
      voice: { type: 'string', description: 'set: brand voice & tone.' },
      styleguide: { type: 'string', description: 'set: visual style rules (palette, layout, imagery).' },
      language: { type: 'string', description: 'set: language / terminology do & don\'t.' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'set: artifact ids of reference images (replaces the list).' },
    },
    required: ['action'],
    additionalProperties: false,
  };
  return {
    name: 'brand_kit',
    description:
      'Read or write a brand kit — the voice, visual style, language rules, and reference images that ' +
      'ground content generation so it stays on-brand. Scopes cascade: "default" (house style) → ' +
      '"venture:<id>" (per-venture, inherits parent ventures) → "venture:<id>:<channel>" (channel ' +
      'sub-brand). get returns { kit (this scope), effective (merged cascade), chain }; set edits the ' +
      'exact scope. Actions: { action: "get", scope? } | { action: "set", scope?, voice?, styleguide?, ' +
      'language?, reference_images? } (partial — only named fields change) | { action: "list" }.',
    inputSchema,
    executor: {
      async *execute(input) {
        if (!tryCurrentPrincipal()) return yield { type: 'error', message: 'no user context — brand kits are owner-scoped' };
        const a = (input ?? {}) as Partial<BrandInput> & { action?: string; reference_images?: unknown };
        const action = str(a.action).trim();
        const scope = str((a as { scope?: unknown }).scope).trim() || 'default';

        if (action === 'list') {
          const scopes = await db.listScopes();
          return yield { type: 'result', value: { scopes } };
        }
        if (action === 'get') {
          // Resolve the cascade: the exact-scope `layer` (what a set would edit) plus the merged
          // `effective` brand generation actually uses (default → venture ancestry → channel).
          const resolved = await db.resolveBrand(scope);
          return yield {
            type: 'result',
            value: {
              scope,
              kit: resolved.layer,
              effective: resolved.effective,
              chain: resolved.chain,
              prompt_block: composeBrandBlock(resolved.effective),
            },
          };
        }
        if (action === 'set') {
          const patch: BrandPatch = {};
          const s = a as { voice?: unknown; styleguide?: unknown; language?: unknown; reference_images?: unknown };
          if (typeof s.voice === 'string') patch.voice = s.voice;
          if (typeof s.styleguide === 'string') patch.styleguide = s.styleguide;
          if (typeof s.language === 'string') patch.language = s.language;
          if (Array.isArray(s.reference_images)) patch.reference_images = s.reference_images.map(String);
          if (Object.keys(patch).length === 0) return yield { type: 'error', message: 'set needs at least one of voice / styleguide / language / reference_images' };
          const kit = await db.setBrand(scope, patch);
          if (!kit) return yield { type: 'error', message: 'could not save the brand kit' };
          return yield { type: 'result', value: { saved: true, scope, kit } };
        }
        yield { type: 'error', message: `unknown action "${action}" — use get | set | list` };
      },
    },
  };
}
