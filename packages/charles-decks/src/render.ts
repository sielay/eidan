// SPDX-License-Identifier: AGPL-3.0-or-later
// Marp render — the deterministic half of the deck tool (charles#8). The agent composes Marp
// markdown (the judgement: what's on the slides, in the house style); this module renders it to
// bytes (the mechanic) by shelling out to the `marp` CLI (@marp-team/marp-cli). HTML needs only
// Node; pptx/pdf additionally need headless Chromium on the host (or a render sidecar).
//
// Pure I/O, no agent state — kept separate from tools.ts so it can be mocked in tests and swapped
// for a render sidecar later.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Output format -> whether headless Chromium is required to render it.
export const SUPPORTED_FORMATS: Record<string, boolean> = {
  html: false,
  pdf: true,
  pptx: true,
};

const RENDER_TIMEOUT_MS = Number(process.env['EIDAN_MARP_TIMEOUT_S'] ?? '120') * 1000;

/** A marp render failed (binary missing, non-zero exit, empty output). */
export class DeckRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckRenderError';
  }
}

function marpBin(): string {
  return (process.env['EIDAN_MARP_BIN'] ?? 'marp').trim() || 'marp';
}

/**
 * Render Marp `markdown` to each requested format. Returns a map of format -> bytes. Throws
 * DeckRenderError on an unknown format, a missing `marp` binary, a non-zero exit, or empty output.
 * Renders happen in one temp dir; the markdown is written once and each format is produced from it
 * (marp infers the format from the -o extension).
 */
export async function renderMarp(markdown: string, formats: string[]): Promise<Map<string, Uint8Array>> {
  const unknown = formats.filter((f) => !(f in SUPPORTED_FORMATS));
  if (unknown.length) {
    throw new DeckRenderError(
      `unsupported deck format(s): ${unknown.join(', ')}; supported: ${Object.keys(SUPPORTED_FORMATS).sort().join(', ')}`,
    );
  }
  if (!markdown.trim()) throw new DeckRenderError('deck markdown is empty');

  const out = new Map<string, Uint8Array>();
  const tmp = await mkdtemp(join(tmpdir(), 'eidan-deck-'));
  try {
    const src = join(tmp, 'deck.md');
    await writeFile(src, markdown, 'utf8');
    for (const fmt of formats) {
      const dst = join(tmp, `deck.${fmt}`);
      await runMarp(src, dst, fmt);
      const data = await readFile(dst);
      if (!data.length) throw new DeckRenderError(`marp produced an empty ${fmt} file`);
      out.set(fmt, new Uint8Array(data));
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return out;
}

/** Invoke the marp CLI for one output format. */
function runMarp(src: string, dst: string, fmt: string): Promise<void> {
  const args = [src, '-o', dst];
  // pptx/pdf go through the headless browser; allow it to read the temp input file. (--pptx/--pdf
  // are inferred from the -o extension.)
  if (SUPPORTED_FORMATS[fmt]) args.push('--allow-local-files');

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(marpBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (err?: DeckRenderError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(new DeckRenderError(`marp render timed out after ${RENDER_TIMEOUT_MS / 1000}s for ${fmt}`));
    }, RENDER_TIMEOUT_MS);

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        finish(
          new DeckRenderError(
            `marp CLI not found ('${marpBin()}'). Install @marp-team/marp-cli (+ Chromium for pptx/pdf) or set EIDAN_MARP_BIN.`,
          ),
        );
      } else {
        finish(new DeckRenderError(`marp failed to start: ${err.message}`));
      }
    });
    proc.on('close', (code) => {
      if (code === 0) finish();
      else finish(new DeckRenderError(`marp exited ${code} for ${fmt}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}
