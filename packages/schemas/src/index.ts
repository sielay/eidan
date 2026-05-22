// Public surface for @eidan/schemas. Re-exports the generated Zod
// schemas (and their inferred types) plus any adapter-layer
// refinements. Consumers import named DTOs directly:
//
//     import { TurnInput, CostSummary } from "@eidan/schemas";
//
// Generated outputs live under src/generated/ and are committed; CI
// fails on a regen diff (docs/004 §6.3). Refinements that JSON
// Schema cannot express live in adapters.ts.
//
// When a schema name appears in both layers (e.g. ``IntendedActions``
// — see adapters.ts for why), the adapter wins. The bare generated
// symbol stays reachable via ``@eidan/schemas/generated/...`` for
// debugging or direct JSON-Schema parity checks.

export { CostSummary } from "./generated/core/cost/CostSummary";
export { PluginManifest } from "./generated/core/plugin/PluginManifest";
export { TurnChunk } from "./generated/core/turn/TurnChunk";
export { TurnComplete } from "./generated/core/turn/TurnComplete";
export { TurnInput } from "./generated/core/turn/TurnInput";

// IntendedActions ships from adapters.ts (json-schema-to-zod 2.6.1
// inlines $defs as z.any(); the adapter restores the discriminated
// union).
export {
  CreateEvent,
  IntendedAction,
  IntendedActions,
  Lookup,
  SendMessage,
  Unknown,
  UpdateRow,
} from "./adapters";
