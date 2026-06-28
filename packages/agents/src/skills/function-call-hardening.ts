// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Function Call Hardening Skill: provider-specific formatting rules to prevent tool-call failures.
 *
 * Function calls are the most failure-prone part of agent execution. This skill documents
 * pain points discovered in production (especially with DeepSeek) and provider-specific
 * workarounds.
 *
 * Agents reference this skill in their persona via: "[skill: Function Call Hardening]"
 * Particularly important for multi-provider deployments where models have different strictness.
 */

export const FUNCTION_CALL_HARDENING = `# Function Call Hardening

## The Problem

Function calls fail for subtle reasons: missing fields, wrong type, trailing commas in JSON, misnamed parameters. When a function call is malformed, the model usually tries again and fails again, wasting tokens and your time.

## Hardening Strategies

### JSON Validation (All Providers)

Before calling a tool, mentally validate:
1. **Field presence:** Does every \`required\` parameter have a value (not null, not omitted)?
2. **Field type:** Is each parameter the right JSON type (string, number, boolean, array, object)?
3. **Nested objects:** Are nested objects valid JSON with no trailing commas?
4. **String escaping:** Do strings escape quotes and newlines correctly?

**Golden example:**
[code block: json]
{
  "name": "my-agent",
  "persona": "Review emails and summarize",
  "provider": "claude"
}
[end code block]

**Bad examples:**
- \`"provider": "claude",\` ← trailing comma (JSON error)
- \`"name": \` ← missing value
- \`"personas": "Review…"\` ← wrong field name
- \`name: "my-agent"\` ← unquoted key (not JSON)

### DeepSeek-Specific Issues

DeepSeek is stricter about function calls than Claude. If you see "function call failed" on DeepSeek:

1. **Validate JSON manually first.** Paste your call into a JSON validator before submitting.
2. **Be explicit about tool choice.** Instead of hoping DeepSeek guesses your tool: "You MUST call the tool_name tool with these exact parameters: {json here}"
3. **One tool per response.** Don't batch multiple tools in a single turn on DeepSeek; call them sequentially.
4. **No optional fields in nested objects.** If a nested object field is optional, omit it entirely rather than passing \`null\`.

### Parameter Naming

Tool parameter names are case-sensitive and must match the schema exactly.
- ✓ \`agent_id\` (snake_case)
- ✓ \`agentId\` (camelCase, if the schema says so)
- ✗ \`agent_ID\` (wrong casing)
- ✗ \`agentid\` (missing separator)

**Before calling:** Check the tool's inputSchema for the exact parameter names.

### Enum and Choice Constraints

If a parameter has \`enum: [choice1, choice2]\`, pick exactly one. Don't guess:
- \`relation: "delegates_to"\` ✓
- \`relation: "delegates-to"\` ✗
- \`relation: ["delegates_to"]\` ✗ (must be a string, not an array)

### Array Handling

If a parameter is \`type: "array"\`, pass an array even if it's a single item:
- \`tags: ["python"]\` ✓
- \`tags: "python"\` ✗

## Recovery Patterns

### "Tool call failed / malformed"

1. Look at the error detail (if provided).
2. Check the tool's inputSchema again; compare your parameters.
3. Rewrite the call more carefully.
4. Try once more.
5. If still broken, escalate: "Tool X failed twice with malformed input; need human review."

### "Tool call was ignored"

Some models (especially older ones or local models) ignore tool calls. If this happens:
1. Try rephrasing the request to emphasize the tool call.
2. Try again with explicit JSON in code blocks.
3. Escalate if the tool is critical to your task.

## Provider-Specific Success Rates

| Provider | Function Call Rate | Notes |
|----------|-------------------|-------|
| Claude 3.5+ | 99%+ | Highly reliable; rarely fails on valid JSON |
| DeepSeek | 95%+ | Strict; requires explicit JSON validation |
| OpenRouter (Claude relay) | 99%+ | Same as Claude |
| Local Ollama | Varies | Some models ignore tools entirely |
| OpenAI GPT-4 | 99%+ | Reliable |

## Debugging Checklist

When a function call fails:

- [ ] Is the JSON valid? (Paste into jsonlint.com)
- [ ] Does the parameter name match the schema (case-sensitive)?
- [ ] Is every \`required\` field present?
- [ ] Are all field types correct (string, number, boolean)?
- [ ] Are there trailing commas or unquoted keys?
- [ ] If it's an enum, is the value exactly one of the choices?
- [ ] On DeepSeek: did you validate JSON manually before sending?
- [ ] Have you tried a simplified version (fewer fields) first?

---

**Version:** 1.0
**Last Updated:** 2025-06-28
`;

export const FUNCTION_CALL_HARDENING_ID = 'function-call-hardening';
