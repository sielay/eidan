# @eidandev/transcribe

Speech-to-text for eidan. Registers the **`Transcribe`** service used by the chat mic button
(`POST /api/transcribe` in `@eidandev/frontend-agui`) and the Telegram voice handler.

Provider-agnostic — it POSTs `multipart/form-data` to any **Whisper-compatible** (OpenAI-style)
`/audio/transcriptions` endpoint:

| env | meaning | example |
|---|---|---|
| `EIDAN_WHISPER_ENDPOINT` | full transcriptions URL | `https://api.groq.com/openai/v1/audio/transcriptions` or `https://api.openai.com/v1/audio/transcriptions` |
| `EIDAN_WHISPER_MODEL` | model id (default `whisper-1`) | `whisper-large-v3-turbo` (Groq) / `whisper-1` (OpenAI) |
| `EIDAN_WHISPER_KEY` | bearer key | a Groq / OpenAI key |

Without an endpoint + key the service registers but is **inert** (`available()` is false), so voice
UI degrades gracefully.

> ⚠️ **OpenRouter cannot transcribe.** Its API is chat-completions only — there is no
> `/audio/transcriptions`. Use OpenAI or Groq (Groq's `whisper-large-v3-turbo` is the cheap/fast pick).
