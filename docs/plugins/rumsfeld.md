# Rumsfeld · matbot engine plugin

Rumsfeld is a contextual knowledge fault handler. It registers a single
`contextual_search` tool that queries the active knowledge index when the model
encounters an unknown concept, system, term, entity, person, or domain it lacks
specific context about. The model lists the unknown terms (and the phrase they
appeared in), and the tool returns the best-matching knowledge entry so the
agent can continue with real domain context instead of guessing.

This is a plugin from the matbot engine (Apache-2.0,
[github.com/MatAtBread/matbot](https://github.com/MatAtBread/matbot)), available
to enable in eidan. The eidan agent uses it as the primary consumption path into
the knowledge subsystem: rather than confabulating about a named system it
wasn't trained on, a user-specific preference, or a specialised topic, it calls
`contextual_search` early — in preference to external web searches and before
asking the user for clarification — and gets back the relevant stored entry. The
name nods to "unknown unknowns": the tool exists to turn a term the model
doesn't recognise into context it can act on.

## Tools

| Tool | Purpose |
| --- | --- |
| `contextual_search` | Look up unknown concepts/terms/entities in the knowledge index. Input: `terms` — an array of `{ term, context? }`, where `term` is the bare noun (stripped of qualifiers, demonstratives, possessives) and `context` is the phrase it was mentioned in. Returns the single best-matching entry as `{ name, content }`. |

## Example

```
User: "Is the Xmit system working, and what does my Volvo say?"
contextual_search({ terms: [
  { term: "Xmit system", context: "Is the Xmit system working" },
  { term: "Volvo",       context: "what does my Volvo say" }
] })
→ { name: "Xmit", content: "..." }   // best match from the knowledge index
```

## Notes

- Reads the active `KnowledgeIndex` core service via `services.KnowledgeIndex.search(...)`; results are only as good as what has been indexed (e.g. skills, persisted knowledge entries). The default index is in-memory; `persist-ki-bge` swaps in a persistent, semantically-reranked backend.
- Returns only the top result. Errors with "There is no skill available for the requested operation" when nothing matches, and with "No search terms provided" on an empty `terms` array.
- Markers of "unknown" terms (per the tool's guidance): definite articles / demonstratives / possessives ("the", "my", "Fred's"), novel proper nouns, domain-specific usage, and any direct mention of a "skill". Split qualified terms ("Fred's car" → "Fred" + "car").
- Cross-runtime (node + browser); no network capability of its own.
