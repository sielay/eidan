# Ask User · matbot engine plugin

The `ask-user` plugin lets the eidan agent pause and ask you a question through an interactive form control rather than guessing or proceeding on incomplete information. The frontend renders the question as a real UI element — a text box, masked password field, multiple-choice buttons, or a yes/no confirm dialog — and the agent waits for your answer before continuing.

This is a plugin from the matbot engine (Apache-2.0, github.com/MatAtBread/matbot), available to enable in eidan. The agent reaches for it when it needs you to choose, confirm an action, or supply a value (such as a secret) that it cannot or should not invent. It runs in both node and browser realms.

## Tools

| Tool | Purpose |
|------|---------|
| `ask_user` | Ask the user one question with an interactive control. Inputs: `name` (machine key for the answer), `label` (the question text), `type` (`text` / `password` / `select` / `confirm`). For `select`, an `options` array (1–10 mutually exclusive choices) is required, with optional `allowOther` to also accept free text. Optional `default`, `required`, and `cancelable` (default true) refine behaviour. Returns `{ name, answer }`; cancelling is reported as an error, not an answer. |

## Example

```json
{
  "name": "skill",
  "label": "Which area should I focus the report on?",
  "type": "select",
  "options": ["Costs", "Schedule", "Risks"],
  "allowOther": true
}
```

The user picks (or types) a value and the tool returns `{ "name": "skill", "answer": "Risks" }`.

## Notes

- A graceful "no thanks / skip / I don't know" should be one of your `options` (or a `confirm`), not a cancel — cancel abandons the whole operation and returns control to the user.
- `password` masks input and does not display the value; use it for secrets, API keys, and tokens.
- `select` accepts at most 10 options; the executor errors on an empty options array, too many options, an invalid `type`, or a missing `name`/`label`.
- `cancelable` defaults to true; set it false only for a prompt the user must not be able to escape.
