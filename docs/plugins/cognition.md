# Cognition · matbot engine plugin

Cognition is a home for cognitive services. Today it seeds three built-in
skills — **Inner voice**, **Remember this**, and **Dream time** — into the
active skills service, and seeds a `remembered_facts` store (via the Tool Store
plugin) that the Remember this skill writes to. It is the intended home for
further cognitive skills and tools.

This is a plugin from the matbot engine (Apache-2.0,
[github.com/MatAtBread/matbot](https://github.com/MatAtBread/matbot)), available
to enable in eidan. The eidan agent benefits from it passively: the seeded
skills give the agent a second-opinion critic, durable fact memory, and a
background memory-consolidation routine. Cognition is a *consumer* of the
skills capability, not a provider — it discovers the live skills service off
the registry, so any skills provider satisfies it. Seeding is order-independent
and self-healing: if no skills service is present at setup, it installs a
one-shot hook that seeds on the first turn one appears.

## Tools

Registers no tools of its own. It seeds skills and (via Tool Store) the
`remembered_facts` store, which exposes a `remembered_facts_action` tool used by
the Remember this and Dream time skills.

## Example

```
User: "By the way, my hydro station supplies 25% of my village's electricity."
→ "Remember this" trigger fires → remembered_facts_action({ action: "set",
   data: { fact: "...", sessionId, messageId, createdAt } })
Later, run via the `background` tool:
→ "Dream time" takes one unassigned fact, finds the best skill to merge it into,
   flags contradictions, and marks the fact processed (a dreamSkill field).
```

## Notes

- **Inner voice** consults a second model via the `single_turn` tool, requiring a provider named `inner-voice` (ideally a different training lineage than the main model). Without it the skill still fires but the `single_turn` call errors back with no critique.
- **Remember this** captures user-provided facts/preferences with provenance (session + message). Each distinct fact gets its own document.
- **Dream time** is a background consolidation pass — run via the `background` tool, never inline. It has no automatic triggers, so schedule it yourself; it processes one fact per pass to keep each cycle short and cheap.
- Seeding is create-if-absent: an install that already holds a skill or store of the same name keeps its own copy. The `remembered_facts` store is idempotent across restarts.
- Depends on the matbot skills and tool-store plugins; cross-runtime (node + browser).
