// SPDX-License-Identifier: AGPL-3.0-or-later
// The render_deck agent tool (charles#8). A flagship Charles capability for non-technical
// operators: "make me a board deck" → an editable file they can download. The agent composes Marp
// markdown (slides + house style); this tool renders it deterministically (render.ts), stores each
// format via matbot's FileStore (ctx.files), and emits a `file` event per format so it surfaces as
// a download chip on the message.
import type { Tool, JSONSchema, MimeType } from '@matatbread/matbot-plugin-api';
import { DeckRenderError, SUPPORTED_FORMATS, renderMarp } from './render.js';

const MIME: Record<string, MimeType> = {
  html: 'text/html',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const DEFAULT_FORMATS = ['pptx', 'html'];
const FILENAME_RE = /[^a-zA-Z0-9._-]+/g;

const RENDER_DECK_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    markdown: {
      type: 'string',
      description:
        'The deck as Marp markdown (`---` separates slides). YOU compose this — the slide content, ' +
        'structure, and house style.',
      minLength: 1,
    },
    filename: {
      type: 'string',
      description: "Base filename, no extension (e.g. 'q2-board-deck').",
      minLength: 1,
    },
    title: { type: 'string', description: 'Human title for the download chip / metadata.' },
    formats: {
      type: 'array',
      items: { type: 'string', enum: Object.keys(SUPPORTED_FORMATS).sort() },
      description: "Output formats (default ['pptx','html']). pdf/pptx need headless Chromium on the host.",
    },
  },
  required: ['markdown', 'filename'],
  additionalProperties: false,
};

function safeFilename(raw: string): string {
  const name = raw.trim().replace(FILENAME_RE, '-').replace(/^[-.]+|[-.]+$/g, '');
  return (name || 'deck').slice(0, 120);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

async function* once(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/** The render_deck tool. Stateless — it uses the per-call FileStore (ctx.files), so the deck is
 *  owned by the user whose turn invoked it (ambient principal). */
export function buildDeckTools(): Tool[] {
  return [
    {
      name: 'render_deck',
      description:
        'Render a presentation deck (composed by you as Marp markdown) into editable file(s) — ' +
        "pptx/html/pdf — and return download links. Use this for 'make me a deck / board " +
        "presentation / slides' requests: YOU write the Marp markdown (slides, content, house " +
        'style); this renders + stores it and returns artifact refs that appear as download chips.',
      inputSchema: RENDER_DECK_SCHEMA,
      executor: {
        async *execute(input, ctx) {
          const files = ctx.files;
          if (!files) {
            return yield { type: 'error', message: 'no file store available — render_deck needs an artifact-backed host' };
          }
          const args = (input ?? {}) as Record<string, unknown>;
          const markdown = str(args['markdown']);
          if (!markdown.trim()) return yield { type: 'error', message: 'markdown is required and must be non-empty' };
          const filename = safeFilename(str(args['filename']));
          const title = str(args['title']) || filename;
          const rawFormats = args['formats'];
          const formats =
            Array.isArray(rawFormats) && rawFormats.length ? rawFormats.map((f) => str(f)) : DEFAULT_FORMATS;

          let rendered: Map<string, Uint8Array>;
          try {
            rendered = await renderMarp(markdown, formats);
          } catch (exc) {
            if (exc instanceof DeckRenderError) return yield { type: 'error', message: `deck render failed: ${exc.message}` };
            throw exc;
          }

          const produced: Array<Record<string, unknown>> = [];
          for (const [fmt, data] of rendered) {
            const name = `${filename}.${fmt}`;
            const mime = MIME[fmt] ?? 'application/octet-stream';
            // sessionId links the file to the conversation; allowed:true makes it servable as a
            // download chip (default-deny otherwise).
            const handle = await files.put(name, mime, once(data), {
              sessionId: ctx.session.id,
              namespace: 'deck',
              allowed: true,
            });
            produced.push({ format: fmt, filename: name, artifact_id: handle.id, size_bytes: handle.size });
            // The native way to surface a produced file to the frontend (a download chip).
            yield { type: 'file', handle };
          }
          yield { type: 'result', value: { title, artifacts: produced } };
        },
      },
    },
  ];
}
