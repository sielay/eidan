// SPDX-License-Identifier: AGPL-3.0-or-later

export type ModelType = "frontier" | "mid-tier" | "lightweight";
export type ModelSize = "7B" | "8B" | "14B" | "70B" | "100B+" | "proprietary";

export interface ModelMetadata {
  id: string; // e.g., "anthropic/claude-sonnet-4-6", "ollama/llama2"
  name: string; // Display name
  provider: string; // Anthropic, OpenAI, DeepSeek, etc.
  type: ModelType;
  size: ModelSize;
  contextWindow?: number; // in tokens
  tags: string[]; // e.g., "supports-vision", "cache-compatible", "function-calls"
  promptPrice?: number; // per 1M tokens
  completionPrice?: number; // per 1M tokens
  recommended?: boolean;
  recommendedFor?: string; // e.g., "Routine tasks", "Complex reasoning"
}

const builtinModels: ModelMetadata[] = [
  {
    id: "anthropic/claude-opus-4-7",
    name: "Claude Opus 4.7",
    provider: "Anthropic",
    type: "frontier",
    size: "proprietary",
    contextWindow: 200000,
    tags: ["supports-vision", "cache-compatible", "function-calls"],
    promptPrice: 3,
    completionPrice: 15,
    recommended: true,
    recommendedFor: "Complex reasoning & analysis",
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "Anthropic",
    type: "mid-tier",
    size: "proprietary",
    contextWindow: 200000,
    tags: ["supports-vision", "cache-compatible", "function-calls"],
    promptPrice: 3,
    completionPrice: 15,
    recommended: true,
    recommendedFor: "General purpose",
  },
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "Anthropic",
    type: "lightweight",
    size: "proprietary",
    contextWindow: 200000,
    tags: ["supports-vision", "cache-compatible", "function-calls"],
    promptPrice: 0.8,
    completionPrice: 4,
    recommended: true,
    recommendedFor: "Routine tasks",
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    provider: "OpenAI",
    type: "frontier",
    size: "proprietary",
    contextWindow: 128000,
    tags: ["supports-vision", "function-calls"],
    promptPrice: 5,
    completionPrice: 15,
  },
  {
    id: "openai/gpt-4-turbo",
    name: "GPT-4 Turbo",
    provider: "OpenAI",
    type: "mid-tier",
    size: "proprietary",
    contextWindow: 128000,
    tags: ["supports-vision", "function-calls"],
    promptPrice: 10,
    completionPrice: 30,
  },
  {
    id: "openai/gpt-3.5-turbo",
    name: "GPT-3.5 Turbo",
    provider: "OpenAI",
    type: "lightweight",
    size: "proprietary",
    contextWindow: 16385,
    tags: ["function-calls"],
    promptPrice: 0.5,
    completionPrice: 1.5,
  },
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek Chat",
    provider: "DeepSeek",
    type: "mid-tier",
    size: "proprietary",
    contextWindow: 64000,
    tags: ["supports-vision", "function-calls"],
    promptPrice: 0.14,
    completionPrice: 0.28,
  },
  {
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "DeepSeek",
    type: "frontier",
    size: "proprietary",
    contextWindow: 64000,
    tags: ["function-calls"],
    promptPrice: 0.55,
    completionPrice: 2.19,
  },
  {
    id: "meta-llama/llama-2-70b-chat",
    name: "Llama 2 70B Chat",
    provider: "Meta",
    type: "mid-tier",
    size: "70B",
    contextWindow: 4096,
    tags: ["function-calls"],
    promptPrice: 0.7,
    completionPrice: 0.9,
  },
  {
    id: "meta-llama/llama-3-70b-chat",
    name: "Llama 3 70B Chat",
    provider: "Meta",
    type: "mid-tier",
    size: "70B",
    contextWindow: 8192,
    tags: ["function-calls"],
    promptPrice: 0.59,
    completionPrice: 0.79,
  },
  {
    id: "meta-llama/llama-3.1-70b-instruct",
    name: "Llama 3.1 70B Instruct",
    provider: "Meta",
    type: "mid-tier",
    size: "70B",
    contextWindow: 128000,
    tags: ["function-calls"],
    promptPrice: 0.59,
    completionPrice: 0.79,
  },
  {
    id: "meta-llama/llama-3.1-405b-instruct",
    name: "Llama 3.1 405B Instruct",
    provider: "Meta",
    type: "frontier",
    size: "100B+",
    contextWindow: 128000,
    tags: ["function-calls"],
    promptPrice: 1.99,
    completionPrice: 2.99,
  },
  {
    id: "mistralai/mistral-large-2",
    name: "Mistral Large 2",
    provider: "Mistral",
    type: "mid-tier",
    size: "proprietary",
    contextWindow: 32768,
    tags: ["function-calls"],
    promptPrice: 2,
    completionPrice: 6,
  },
  {
    id: "mistralai/mistral-small",
    name: "Mistral Small",
    provider: "Mistral",
    type: "lightweight",
    size: "proprietary",
    contextWindow: 32768,
    tags: ["function-calls"],
    promptPrice: 0.14,
    completionPrice: 0.42,
  },
  {
    id: "qwen/qwen-max",
    name: "Qwen Max",
    provider: "Alibaba",
    type: "frontier",
    size: "proprietary",
    contextWindow: 8192,
    tags: ["supports-vision", "function-calls"],
    promptPrice: 0,
    completionPrice: 0,
  },
  {
    id: "google/gemini-pro",
    name: "Gemini Pro",
    provider: "Google",
    type: "mid-tier",
    size: "proprietary",
    contextWindow: 32768,
    tags: ["supports-vision", "function-calls"],
  },
  {
    id: "cohere/command-r-plus",
    name: "Command R+",
    provider: "Cohere",
    type: "mid-tier",
    size: "proprietary",
    contextWindow: 128000,
    tags: ["function-calls"],
    promptPrice: 3,
    completionPrice: 15,
  },
  {
    id: "perplexity/pplx-7b-online",
    name: "Perplexity 7B Online",
    provider: "Perplexity",
    type: "lightweight",
    size: "7B",
    contextWindow: 8000,
    tags: [],
  },
];

export function getBuiltinModels(): ModelMetadata[] {
  return [...builtinModels];
}

export function mergeModels(
  openRouterModels: Array<{ id: string; name: string; prompt: string | null; completion: string | null; context?: number | null }>,
): ModelMetadata[] {
  const builtinMap = new Map(builtinModels.map((m) => [m.id, m]));
  const result: ModelMetadata[] = [];

  // Add OpenRouter models, merging with builtin metadata if available
  const seen = new Set<string>();
  for (const m of openRouterModels) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);

    if (builtinMap.has(m.id)) {
      result.push(builtinMap.get(m.id)!);
    } else {
      // Infer metadata from the model id for unknown models
      const [provider, ...parts] = m.id.split("/");
      result.push({
        id: m.id,
        name: m.name || m.id,
        provider: provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "Unknown",
        type: "mid-tier",
        size: "proprietary",
        contextWindow: m.context || undefined,
        tags: [],
        promptPrice: m.prompt ? Number(m.prompt) * 1_000_000 : undefined,
        completionPrice: m.completion ? Number(m.completion) * 1_000_000 : undefined,
      });
    }
  }

  // Add builtin models not in OpenRouter list (e.g., ollama)
  for (const m of builtinModels) {
    if (!seen.has(m.id)) {
      result.push(m);
    }
  }

  return result;
}

export function getRecommendedModels(models: ModelMetadata[]): ModelMetadata[] {
  return models.filter((m) => m.recommended).sort((a, b) => {
    // Sort: frontier first, then mid-tier
    const typeOrder = { frontier: 0, "mid-tier": 1, lightweight: 2 };
    return typeOrder[a.type] - typeOrder[b.type];
  });
}
