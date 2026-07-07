// SPDX-License-Identifier: AGPL-3.0-or-later
// image_generate — the deterministic image step of the content workflow. Calls OpenAI's images API
// (gpt-image-1) over plain fetch (no SDK), saves each result as a downloadable artifact via the
// FileStore (ctx.files), and returns the artifact ids so the agent can link them to a board card
// (boards `card_link`, ref_kind "artifact"). Secrets come from the vault, never process.env.
import type { Tool, JSONSchema, MimeType, ToolContext } from '@matatbread/matbot-plugin-api';
import { MissingSecretError } from '@matatbread/matbot-plugin-api';

const ENDPOINT = 'https://api.openai.com/v1/images/generations';
const MODEL = 'gpt-image-1';
export const SIZES = ['1024x1024', '1024x1536', '1536x1024', 'auto'];
export const QUALITIES = ['low', 'medium', 'high', 'auto'];

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
export function normalizeParams(a: Record<string, unknown>): { n: number; size: string; quality: string; base: string } {
  const rawN = typeof a['n'] === 'number' ? Math.floor(a['n']) : 1;
  const n = Math.min(Math.max(rawN, 1), 4);
  const size = typeof a['size'] === 'string' && SIZES.includes(a['size']) ? a['size'] : '1024x1024';
  const quality = typeof a['quality'] === 'string' && QUALITIES.includes(a['quality']) ? a['quality'] : 'medium';
  const rawBase = typeof a['filename'] === 'string' && a['filename'].trim() ? a['filename'].trim() : 'image';
  const base = rawBase.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
  return { n, size, quality, base };
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
      n: { type: 'number', description: 'How many images (1–4). Default 1.' },
      size: { type: 'string', enum: SIZES, description: 'Image size. Default 1024x1024.' },
      quality: { type: 'string', enum: QUALITIES, description: 'Render quality. Default medium.' },
      filename: { type: 'string', description: 'Optional base filename (no extension).' },
    },
    required: ['prompt'],
    additionalProperties: false,
  };
  return {
    name: 'image_generate',
    description:
      'Generate image(s) with OpenAI (gpt-image-1) from a text prompt. Each image is saved as a downloadable ' +
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
        const { n, size, quality, base } = normalizeParams(a);

        let key: string;
        try { key = await resolveKey(ctx); }
        catch (e) { yield { type: 'error', message: e instanceof Error ? e.message : String(e) }; return; }

        let resp: Response;
        try {
          resp = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: MODEL, prompt, n, size, quality }),
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
        yield { type: 'result', value: { model: MODEL, prompt, size, quality, artifacts: produced, images: produced } };
      },
    },
  };
}
