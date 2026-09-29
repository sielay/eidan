// SPDX-License-Identifier: AGPL-3.0-or-later
// image_generate — the deterministic image step of the content workflow. Calls OpenAI's images API
// (gpt-image-1) over plain fetch (no SDK), saves each result as a downloadable artifact via the
// FileStore (ctx.files), and returns the artifact ids so the agent can link them to a board card
// (boards `card_link`, ref_kind "artifact"). Secrets come from the vault, never process.env.
import type { Tool, JSONSchema, MimeType, ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

const ENDPOINT = 'https://api.openai.com/v1/images/generations';
export const MODELS = ['gpt-image-1', 'dall-e-3', 'dall-e-2'];
const DEFAULT_MODEL = 'gpt-image-1';
// Union of sizes/qualities across models — per-model validity is enforced in buildRequestBody (invalid
// combos are corrected, not passed through), so the agent can pick any and we do the right thing.
export const SIZES = ['1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792', '512x512', '256x256', 'auto'];
export const QUALITIES = ['low', 'medium', 'high', 'auto', 'standard', 'hd'];
const DALLE3_SIZES = ['1024x1024', '1792x1024', '1024x1792'];
const DALLE2_SIZES = ['256x256', '512x512', '1024x1024'];

// Assemble the model-correct request body. Each OpenAI image model has different size/quality rules;
// rather than error on a mismatch, coerce to the nearest valid value for the chosen model.
export function buildRequestBody(model: string, prompt: string, n: number, size: string, quality: string): Record<string, unknown> {
  if (model === 'dall-e-3') {
    const sz = DALLE3_SIZES.includes(size) ? size : '1024x1024';
    const q = quality === 'high' || quality === 'hd' || quality === 'medium' ? 'hd' : 'standard';
    return { model, prompt, n: 1, size: sz, quality: q, response_format: 'b64_json' }; // dall-e-3: single image, url unless b64 asked
  }
  if (model === 'dall-e-2') {
    const sz = DALLE2_SIZES.includes(size) ? size : '1024x1024';
    return { model, prompt, n, size: sz, response_format: 'b64_json' }; // dall-e-2: no quality param
  }
  if (model.startsWith('gpt-image')) {
    // gpt-image family (gpt-image-1 / -1.5 / -2 / mini …): b64 native, low/medium/high/auto quality.
    // Map dall-e quality words so a cross-model quality value still works. gpt-image-1 has a fixed size
    // set (coerce); newer gpt-image-* may support more, so pass their size through untouched.
    const q = quality === 'hd' ? 'high' : quality === 'standard' ? 'medium'
      : ['low', 'medium', 'high', 'auto'].includes(quality) ? quality : 'medium';
    const sz = model === 'gpt-image-1'
      ? (['1024x1024', '1024x1536', '1536x1024', 'auto'].includes(size) ? size : '1024x1024')
      : size;
    return { model, prompt, n, size: sz, quality: q };
  }
  // Anything else (a non-gpt-image, non-dall-e id): pass the params straight through and let OpenAI
  // validate — never silently coerce to a model we happen to hardcode, so any model the operator names
  // is actually usable, and an unrecognised one returns a clear API error instead of a wrong image.
  return { model, prompt, n, size, quality };
}

async function* once(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

// base64 → bytes using web APIs (no Node Buffer), so the codec stays portable.
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Pure input normalisation — clamped counts, allow-listed size/quality, safe filename base.
export function normalizeParams(a: Record<string, unknown>): { model: string; n: number; size: string; quality: string; base: string } {
  // Accept ANY non-empty model id (pass-through) — do not restrict to a hardcoded list, so newer OpenAI
  // image models work without a code change. Empty/absent → default.
  const model = typeof a['model'] === 'string' && a['model'].trim() ? a['model'].trim() : DEFAULT_MODEL;
  const rawN = typeof a['n'] === 'number' ? Math.floor(a['n']) : 1;
  const n = Math.min(Math.max(rawN, 1), 4);
  const size = typeof a['size'] === 'string' && SIZES.includes(a['size']) ? a['size'] : '1024x1024';
  const quality = typeof a['quality'] === 'string' && QUALITIES.includes(a['quality']) ? a['quality'] : 'medium';
  const rawBase = typeof a['filename'] === 'string' && a['filename'].trim() ? a['filename'].trim() : 'image';
  const base = rawBase.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
  return { model, n, size, quality, base };
}

async function resolveKey(ctx: ToolContext): Promise<string> {
  try {
    const v = await ctx.vault.resolve('${OPENAI_API_KEY}');
    if (!v) throw new Error('empty');
    return v;
  } catch (e) {
    if (e instanceof MissingSecretError) {
      throw new Error('Required secret OPENAI_API_KEY not found — add an OpenAI API key to the vault.');
    }
    throw e;
  }
}

interface OpenAiImageResponse {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string };
}

export function imageGenerateTool(): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to generate — be specific about subject, style, composition.', minLength: 1 },
      model: { type: 'string', description: 'Image model — any current OpenAI image model id (pass-through). Known: gpt-image-1 (default, best quality), dall-e-3 (single image, standard/hd), dall-e-2 (cheaper, smaller). An id OpenAI does not recognise returns a clear error — it is NOT silently swapped.' },
      n: { type: 'number', description: 'How many images (1–4; dall-e-3 always makes 1). Default 1.' },
      size: { type: 'string', enum: SIZES, description: 'Image size. gpt-image-1: 1024x1024/1024x1536/1536x1024/auto; dall-e-3: 1024x1024/1792x1024/1024x1792; dall-e-2: 256/512/1024². Default 1024x1024; invalid combos are auto-corrected.' },
      quality: { type: 'string', enum: QUALITIES, description: 'Render quality. gpt-image-1: low/medium/high/auto; dall-e-3: standard/hd. Default medium.' },
      filename: { type: 'string', description: 'Optional base filename (no extension).' },
    },
    required: ['prompt'],
    additionalProperties: false,
  };
  return {
    name: 'image_generate',
    description:
      'Generate image(s) with OpenAI from a text prompt. Pick the `model` (gpt-image-1 default; dall-e-3 / dall-e-2 also supported). Each image is saved as a downloadable ' +
      'artifact and returned with its `artifact_id` — link it to a board card via the boards `card_link` tool ' +
      '(ref_kind "artifact") to keep a campaign\'s assets on the card. Requires an OpenAI API key in the vault ' +
      '(OPENAI_API_KEY). This actually renders the images — do not claim an image exists without calling it.',
    inputSchema,
    executor: {
      async *execute(input, ctx) {
        const files = ctx.files;
        if (!files) { yield { type: 'error', message: 'no file store available on this node' }; return; }
        const a = (input ?? {}) as Record<string, unknown>;
        const prompt = (typeof a['prompt'] === 'string' ? a['prompt'] : '').trim();
        if (!prompt) { yield { type: 'error', message: 'prompt is required' }; return; }
        const { model, n, size, quality, base } = normalizeParams(a);

        let key: string;
        try { key = await resolveKey(ctx); }
        catch (e) { yield { type: 'error', message: e instanceof Error ? e.message : String(e) }; return; }

        let resp: Response;
        try {
          resp = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(buildRequestBody(model, prompt, n, size, quality)),
            signal: ctx.signal,
          });
        } catch (e) {
          yield { type: 'error', message: `image request failed: ${e instanceof Error ? e.message : String(e)}` };
          return;
        }
        if (!resp.ok) {
          const body = (await resp.text().catch(() => '')).slice(0, 300);
          yield { type: 'error', message: `OpenAI images HTTP ${resp.status}: ${body}` };
          return;
        }
        const json = (await resp.json()) as OpenAiImageResponse;
        if (json.error?.message) { yield { type: 'error', message: `OpenAI: ${json.error.message}` }; return; }
        const imgs = (json.data ?? []).filter((d): d is { b64_json: string } => typeof d.b64_json === 'string');
        if (!imgs.length) { yield { type: 'error', message: 'OpenAI returned no image data' }; return; }

        const produced: Array<{ artifact_id: string; filename: string; size_bytes: number; format: string }> = [];
        for (let i = 0; i < imgs.length; i++) {
          const bytes = b64ToBytes(imgs[i]!.b64_json);
          const name = `${base}${imgs.length > 1 ? `-${i + 1}` : ''}.png`;
          const handle = await files.put(name, 'image/png' as MimeType, once(bytes), {
            sessionId: ctx.session.id,
            namespace: 'image_gen',
            allowed: true,
          });
          produced.push({ artifact_id: handle.id, filename: name, size_bytes: handle.size, format: 'png' });
          yield { type: 'file', handle };
        }
        // `artifacts` is the key the chat UI parses to render Open/Download chips + an inline preview;
        // keep `images` too for agents that read the structured result.
        yield { type: 'result', value: { model, prompt, size, quality, artifacts: produced, images: produced } };
      },
    },
  };
}
