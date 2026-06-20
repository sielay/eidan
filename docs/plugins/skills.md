# Skills · matbot engine plugin

Skills are named, reusable markdown playbooks — procedures, conventions, and
reference notes the agent stores and recalls on demand. The plugin provides
content CRUD via `skill_action` and trigger CRUD via `skill_triggers`, persists
each skill through the active storage backend, and indexes it into the
knowledge subsystem so it is discoverable by search. A skill is keyed by name
(case-insensitive) and holds markdown content plus optional triggers.

This is a plugin from the matbot engine (Apache-2.0,
[github.com/MatAtBread/matbot](https://github.com/MatAtBread/matbot)), available
to enable in eidan. The eidan agent uses it to capture how-to knowledge once and
have the right playbook surface itself later. Triggers fire skills automatically
across three phases: **system** (a one-line catalogue injected into the system
prompt each turn), **user** (a pre-response `screen` hook that LLM-judges the
incoming user message and injects matched skills ephemerally), and **agent** (a
post-commit `followup` hook that judges the assistant's own response and
resubmits a robo turn naming the matched skills). The `agent`/`user` classifier
needs a provider named `skills-classifier`. Registered on the service registry
as `SkillManager`, so other plugins (e.g. cognition) can seed built-in skills.

## Tools

| Tool | Purpose |
| --- | --- |
| `skill_action` | Manage skill content. `list` (all skills), `load { name }` (full content, for use), `metadata { name }` (derived summary/entities/tags), `save { name, content }` (create or update), `delete { name }`. Triggers are deliberately not returned by `load`. |
| `skill_triggers` | Manage a skill's triggers, each addressed by a stable `id`. `get { name }`, `add { name, phase, trigger }`, `update { name, id, trigger?, phase? }`, `remove { name, id }`. `phase` is `agent` \| `user` \| `system`. |
| `single_turn` | One-shot completion against a *separate* configured `provider` (e.g. a different-lineage critic). Takes `{ provider, prompt, system? }`, returns `{ text, usage }`. |

## Example

```
skill_action({ action: "save", name: "Deploy checklist",
  content: "# Deploy\n1. Run tests\n2. Tag release\n3. Push" })
skill_triggers({ action: "add", name: "Deploy checklist", phase: "system",
  trigger: "Load before any deployment or release task." })
skill_action({ action: "load", name: "Deploy checklist" })   // -> { id, name, content }
```

## Notes

- Cross-runtime (node + browser); a filesystem-watch specialization lives in `@matatbread/matbot-skills-node`. No network capability of its own beyond LLM provider calls.
- Without a `skills-classifier` provider, `agent`/`user` triggers never fire — skills still work when loaded by name. `system` triggers (the catalogue) need no provider.
- `agent`/`user` triggers are CONDITIONS on the form/sentiment of a message (frustration, correction, unverified claims), not topical keywords — topic relevance is found by search, so keyword triggers are redundant. Write them as single LLM-judged "MATCH if … / DO NOT MATCH if …" rubrics.
- Derived `metadata` (summary/entities/tags) is cached LLM analysis, regenerated only when content changes; it may be absent until the background analysis has run.
