# tool-failure-handler

Tool failure detection & decision-making: prevents LLM hallucination on tool failures by detecting errors and using a lightweight LLM to decide recovery strategy.

## Overview

LLMs commonly ignore tool failures and hallucinate forwards as if the tool succeeded. This plugin detects tool failures and uses a lightweight LLM call to decide on a recovery strategy:

- **STOP_AND_ESCALATE**: Critical errors (auth, permissions) that should halt the turn
- **RETIRE_TOOL_CALL**: Tool call was invalid; try a different approach instead of retrying
- **CONTINUE_WITH_ERROR**: Error is informative; let the model see it and decide
- **RETRY_WITH_PARAMS**: Tool might succeed with different parameters; suggest alternatives

## Configuration

Enable the plugin with the opt-in flag:

```bash
EIDAN_TOOL_FAILURE_DETECTION=1
```

Optionally, specify the lightweight model used for decision-making (defaults to `claude-haiku-4-5`):

```bash
EIDAN_TOOL_FAILURE_MODEL=claude-haiku-4-5
```

## How it works

1. Registers a `toolresult` hook that monitors tool execution
2. On tool failure (error response), calls a lightweight LLM to analyze the error
3. LLM returns a recovery strategy based on the error type
4. Adds recovery guidance to the tool result so the main LLM sees the decision
5. For critical failures (`STOP_AND_ESCALATE`), the turn can be halted immediately

## Trade-offs

- **Benefit**: Prevents silent tool failures where the model continues as if nothing went wrong
- **Cost**: Each tool failure triggers an additional LLM call (lightweight model, so minimal cost)
- **Opt-in**: Disabled by default to avoid latency for deployments that don't need it

## Implementation notes

- The decision LLM is called with a focused prompt designed for fast response (haiku-class)
- Invalid strategies from the decision LLM are logged but don't break the turn
- The recovery decision is transparent to the main model via the modified tool result
