"""Upstream classifier calls that run before the primary provider call.

Three cheap calls (`docs/005 §3 ③, ④, ④.5`) gate the primary:

- ``scope`` — what kind of turn is this? Returns a list of skill tags.
- ``sizer`` — which model class should handle the primary call?
- ``intent`` — what actions does the user want performed? Returns a
  structured ``IntendedActions`` list rendered into the primary's
  system prompt and stashed on ``TurnContext`` for the post-primary
  verifier.

Every adapter reads a minimal system prompt and the inbound user
message via the same :class:`Provider` abstraction the primary call
uses, and returns a parsed result alongside the
:class:`ProviderCallResult` so the loop can write the per-call
``llm_calls`` row.
"""

from .intent import IntentResult, classify_intent, render_action_list
from .scope import ScopeResult, classify_scope
from .sizer import SizerResult, pick_model

__all__ = [
    "IntentResult",
    "ScopeResult",
    "SizerResult",
    "classify_intent",
    "classify_scope",
    "pick_model",
    "render_action_list",
]
