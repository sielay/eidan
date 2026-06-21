// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

// Speech-to-text. Provider-agnostic: it POSTs multipart/form-data to ANY Whisper-compatible
// (OpenAI-style) `/audio/transcriptions` endpoint, so the operator points it at OpenAI, Groq, or a
// self-hosted whisper.cpp server via env. NOTE: OpenRouter's API is chat-completions only and does
// NOT transcribe audio — EIDAN_WHISPER_ENDPOINT must be a real transcription endpoint (OpenAI/Groq).
export interface Transcribe {
  // Whether an endpoint + key are configured (callers degrade gracefully when not).
  available(): boolean;
  // Transcribe audio bytes to text. `mime`/`filename` tell the model the codec (e.g. audio/ogg →
  // "voice.ogg", audio/webm → "clip.webm"). Throws on transport/HTTP error.
  transcribe(audio: ArrayBuffer | Uint8Array, opts: { mime: string; filename: string }): Promise<string>;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    Transcribe?: Transcribe;
  }
}

class WhisperTranscribe implements Transcribe {
  readonly endpoint: string;
  readonly model: string;
  readonly key: string;
  constructor(endpoint: string, model: string, key: string) {
    this.endpoint = endpoint;
    this.model = model;
    this.key = key;
  }

  available(): boolean {
    return Boolean(this.endpoint && this.key);
  }

  async transcribe(audio: ArrayBuffer | Uint8Array, opts: { mime: string; filename: string }): Promise<string> {
    if (!this.available()) throw new Error('transcribe: no endpoint/key configured');
    const src = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
    // Copy into a plain ArrayBuffer so Blob accepts it regardless of the source buffer's lib type.
    const buf = new ArrayBuffer(src.byteLength);
    new Uint8Array(buf).set(src);
    const form = new FormData();
    form.append('model', this.model);
    // The filename extension is how Whisper-style endpoints detect the codec — keep it accurate.
    form.append('file', new Blob([buf], { type: opts.mime }), opts.filename);
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`transcribe ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { text?: string };
    return (json.text ?? '').trim();
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Speech-to-text: transcribes audio via any Whisper-compatible /audio/transcriptions endpoint ' +
      '(OpenAI/Groq/self-hosted, set by EIDAN_WHISPER_ENDPOINT/MODEL/KEY). Registers the Transcribe ' +
      'service consumed by the chat mic button and the Telegram voice handler.',
  },
  async setup(services: MatbotServices) {
    // Explicit EIDAN_WHISPER_* is the agnostic path (Groq/self-hosted/etc). As a convenience, if no
    // explicit key is set but OPENAI_API_KEY is, fall back to OpenAI's endpoint — so an operator who
    // already has an OpenAI key gets voice with zero extra config. (We only default the endpoint in
    // the OpenAI-fallback case: an explicit EIDAN_WHISPER_KEY with no endpoint stays inert rather than
    // risk POSTing a non-OpenAI key to OpenAI.)
    const explicitKey = process.env['EIDAN_WHISPER_KEY'] || '';
    const openaiKey = process.env['OPENAI_API_KEY'] || '';
    const key = explicitKey || openaiKey;
    const endpoint = process.env['EIDAN_WHISPER_ENDPOINT']
      || (explicitKey ? '' : (openaiKey ? 'https://api.openai.com/v1/audio/transcriptions' : ''));
    const model = process.env['EIDAN_WHISPER_MODEL'] || 'whisper-1';
    const impl = new WhisperTranscribe(endpoint, model, key);
    await services.register('Transcribe', impl);
    if (impl.available()) {
      console.log(`[transcribe] ready (endpoint=${endpoint}, model=${model})`);
    } else {
      console.warn('[transcribe] registered but inert — set EIDAN_WHISPER_ENDPOINT + EIDAN_WHISPER_KEY to enable voice');
    }
  },
};
