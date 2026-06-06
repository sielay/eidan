"""Provider abstraction — one shape across Anthropic / OpenAI / Gemini / etc.

Phase 1 ships Anthropic and OpenAI adapters; ``ollama`` and
``openrouter`` ride the OpenAI-compatible adapter (the latter as its
own :class:`OpenRouterProvider` subclass, `docs/007 §9`). Other
providers (Gemini, Mistral) land per ``docs/007 §3`` once the host
needs them.
"""

from .anthropic import AnthropicProvider
from .base import (
    AssistantBlock,
    AssistantChunk,
    AssistantMessage,
    Provider,
    ProviderCallResult,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from .openai import OpenAIProvider
from .openrouter import OpenRouterProvider

__all__ = [
    "AnthropicProvider",
    "AssistantBlock",
    "AssistantChunk",
    "AssistantMessage",
    "OpenAIProvider",
    "OpenRouterProvider",
    "Provider",
    "ProviderCallResult",
    "ToolResultBlock",
    "ToolUseBlock",
    "UserMessage",
]
