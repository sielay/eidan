"""Provider abstraction — one shape across Anthropic / OpenAI / Gemini / etc.

Phase 1 ships Anthropic and OpenAI adapters. Other providers (Gemini,
Mistral, Ollama) land per ``docs/007 §3`` once the host needs them.
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

__all__ = [
    "AnthropicProvider",
    "AssistantBlock",
    "AssistantChunk",
    "AssistantMessage",
    "OpenAIProvider",
    "Provider",
    "ProviderCallResult",
    "ToolResultBlock",
    "ToolUseBlock",
    "UserMessage",
]
