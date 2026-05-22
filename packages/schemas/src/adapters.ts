// Hand-written refinements on top of the generated Zod schemas
// (docs/004_SCHEMAS.md §5.1). JSON Schema can express discriminated
// unions, but ``json-schema-to-zod@2.6.1`` does not expand ``$defs``
// references into named consts — it inlines them as ``z.any()``. The
// adapters layer re-establishes the typed surface and is what the
// package index re-exports; the raw generated symbol stays reachable
// via ``./generated/...`` for debugging or direct schema introspection.

import { z } from "zod";

import { IntendedActions as IntendedActionsRaw } from "./generated/core/intent/IntendedActions";

// ── IntendedActions ─────────────────────────────────────────────────
//
// The intent classifier (issue #59, docs/005 §3 step ④.5) emits a list
// of typed actions discriminated on ``kind``. The Python surface gets
// the discriminated union for free via ``datamodel-code-generator``;
// the TS surface needs it spelled out here.

export const CreateEvent = z
  .object({
    kind: z.literal("create_event"),
    when: z
      .string()
      .describe(
        "When the event takes place. ISO 8601 preferred; natural-language is acceptable if the model could not resolve it (the loop's TZ header is available to help, so the model SHOULD resolve relative expressions like 'tomorrow 19:00' to ISO 8601 against the user_tz).",
      ),
    summary: z
      .string()
      .min(1)
      .describe(
        "Short human-readable description of the event ('dentist', 'standup with Lukasz').",
      ),
    location: z.string().describe("Optional location.").optional(),
    duration_minutes: z
      .number()
      .int()
      .min(0)
      .describe("Optional duration.")
      .optional(),
  })
  .strict();

export const UpdateRow = z
  .object({
    kind: z.literal("update_row"),
    table: z
      .string()
      .describe(
        "Fully-qualified table name (e.g. `eidan.user_context`, `plugin_calendar.events`). The verifier queries this table directly.",
      ),
    key: z
      .record(z.unknown())
      .describe(
        "Column → value pairs that identify the row to update. Used by the verifier as a WHERE clause.",
      ),
    fields: z
      .record(z.unknown())
      .describe("Column → new-value pairs the user wants set."),
  })
  .strict();

export const SendMessage = z
  .object({
    kind: z.literal("send_message"),
    channel: z
      .string()
      .describe("Wire channel (e.g. `email`, `telegram`, `sms`)."),
    recipient: z.string().describe("Channel-specific recipient address."),
    body: z.string().describe("Message body the user wants sent."),
  })
  .strict();

export const Lookup = z
  .object({
    kind: z.literal("lookup"),
    query: z.string().min(1),
  })
  .strict()
  .describe(
    "Not verifiable — a lookup has no observable side-effect. The intent classifier SHOULD convert any wording about state change to a verifiable action; only use Lookup when the user is genuinely asking a question.",
  );

export const Unknown = z
  .object({
    kind: z.literal("unknown"),
    note: z
      .string()
      .describe(
        "Free-text description of what the user appears to want, for later debugging / catalogue extension.",
      ),
  })
  .strict()
  .describe(
    "Escape hatch for user expressions that do not fit any catalogued action. Not verifiable. The verifier ignores Unknown entries.",
  );

export const IntendedAction = z
  .discriminatedUnion("kind", [
    CreateEvent,
    UpdateRow,
    SendMessage,
    Lookup,
    Unknown,
  ])
  .describe(
    "A single action the user has expressed. Discriminated on `kind`. Verifiable kinds carry the structural information the post-primary detector needs to check for a matching side-effect.",
  );

export const IntendedActions = z
  .object({
    actions: z
      .array(IntendedAction)
      .describe(
        "Zero or more intended actions, in the order the user expressed them.",
      ),
  })
  .strict()
  .describe(IntendedActionsRaw.description ?? "");

export type CreateEvent = z.infer<typeof CreateEvent>;
export type UpdateRow = z.infer<typeof UpdateRow>;
export type SendMessage = z.infer<typeof SendMessage>;
export type Lookup = z.infer<typeof Lookup>;
export type Unknown = z.infer<typeof Unknown>;
export type IntendedAction = z.infer<typeof IntendedAction>;
export type IntendedActions = z.infer<typeof IntendedActions>;
