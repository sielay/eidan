// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotServices } from '@matatbread/matbot-plugin-api';
import type { VendorResolver } from './observer-tool.js';

// Map a provider endpoint URL to its vendor. The endpoint is the authoritative signal — it survives
// confusingly-named keys (e.g. `openrouter-haiku` repointed to native Anthropic). Match on the parsed
// HOSTNAME (not a substring of the whole URL), so a host like `api.anthropic.com.evil.com` or a path
// segment can't be mistaken for the vendor (CWE-20 / js/incomplete-url-substring-sanitization).
function hostEndsWith(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
function vendorForEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return 'unknown';
  let host: string;
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch { return 'unknown'; }
  if (hostEndsWith(host, 'anthropic.com')) return 'anthropic';
  if (hostEndsWith(host, 'openrouter.ai')) return 'openrouter';
  if (hostEndsWith(host, 'openai.com')) return 'openai';
  if (hostEndsWith(host, 'x.ai')) return 'xai';
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) return 'local';
  return 'other';
}

// Resolve a ledger provider KEY → vendor. Prefers the live provider registry's endpoint (accurate);
// falls back to the synthesized-slug base (`base::model`), then a name heuristic for historical keys
// that are no longer registered. Read lazily so providers registered after this plugin are still seen.
export function makeVendorResolver(services: MatbotServices): VendorResolver {
  const registry = (services as { providers?: { get?: (k: string) => { endpoint?: string } | undefined } }).providers;
  return (provider: string): string => {
    if (!provider) return 'unknown';
    const direct = registry?.get?.(provider);
    if (direct?.endpoint) return vendorForEndpoint(direct.endpoint);
    const base = provider.includes('::') ? provider.split('::')[0] : provider;
    const baseCfg = base && base !== provider ? registry?.get?.(base) : undefined;
    if (baseCfg?.endpoint) return vendorForEndpoint(baseCfg.endpoint);
    const p = provider.toLowerCase();
    if (p.startsWith('openrouter') || p === 'deepseek' || p === 'inner-voice' || p === 'skills-classifier') return 'openrouter';
    if (['claude', 'haiku', 'sonnet', 'opus', 'anthropic'].includes(p)) return 'anthropic';
    if (p === 'ollama' || p.includes('phi') || p.includes('qwen') || p.includes('llama')) return 'local';
    return 'unknown';
  };
}
