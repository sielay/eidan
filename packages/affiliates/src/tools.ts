// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotTool, MatbotServices } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { AffiliateDb, AffiliateProgram } from './db.js';

export function buildAffiliateTools(db: AffiliateDb, services: MatbotServices): MatbotTool[] {
  return [
    {
      name: 'affiliate_programs_list',
      description:
        'List affiliate programs (book, tech, content) with approval status, commission rates, and relevance scores',
      inputSchema: {
        type: 'object' as const,
        properties: {
          category: {
            type: 'string',
            enum: ['book', 'content', 'tech', 'other'],
            description: 'Filter by category (optional)',
          },
          approval_status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected', 'active'],
            description: 'Filter by approval status (optional)',
          },
        },
      },
      execute: async (input: unknown) => {
        const principal = tryCurrentPrincipal();
        if (!principal?.user_id) return { error: 'Not authenticated' };

        const inp = input as Record<string, unknown>;
        const category = inp.category ? String(inp.category) : undefined;

        const programs = await db.listPrograms(principal.user_id, category);

        const filtered = inp.approval_status
          ? programs.filter((p) => p.approval_status === String(inp.approval_status))
          : programs;

        return {
          total: filtered.length,
          programs: filtered.map((p) => ({
            id: p.id,
            name: p.program_name,
            provider: p.provider,
            category: p.category,
            commission_rate: p.commission_rate,
            status: p.approval_status,
            relevance_score: p.relevance_score,
            signup_url: p.signup_url,
            content_types: p.content_types,
          })),
        };
      },
    },
    {
      name: 'affiliate_program_add',
      description: 'Register a new affiliate program',
      inputSchema: {
        type: 'object' as const,
        properties: {
          program_name: { type: 'string', description: 'Program name (e.g., "Kobo Affiliates")' },
          provider: { type: 'string', description: 'Provider/platform (e.g., "kobo", "skillshare")' },
          category: {
            type: 'string',
            enum: ['book', 'content', 'tech', 'other'],
            description: 'Category',
          },
          link_format: {
            type: 'string',
            enum: ['url', 'api', 'pixel'],
            description: 'How to generate affiliate links',
          },
          commission_rate: {
            type: 'number',
            description: 'Commission rate (e.g., 15.5 for 15.5%)',
          },
          signup_url: {
            type: 'string',
            description: 'URL to sign up for the affiliate program',
          },
          api_endpoint: {
            type: 'string',
            description: 'API endpoint for link generation (if link_format is api)',
          },
          content_types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Content types this program works with (e.g., ["video", "article"])',
          },
          relevance_score: {
            type: 'number',
            description: 'Relevance score (0-10)',
          },
        },
        required: ['program_name', 'provider', 'category', 'link_format'],
      },
      execute: async (input: unknown) => {
        const principal = tryCurrentPrincipal();
        if (!principal?.user_id) return { error: 'Not authenticated' };

        const inp = input as Record<string, unknown>;

        try {
          const program = await db.insertProgram(principal.user_id, {
            program_name: String(inp['program_name'] ?? ''),
            provider: String(inp['provider'] ?? ''),
            category: String(inp['category'] ?? 'other'),
            link_format: String(inp['link_format'] ?? 'url'),
            commission_rate: inp['commission_rate'] ? Number(inp['commission_rate']) : undefined,
            signup_url: inp['signup_url'] ? String(inp['signup_url']) : undefined,
            api_endpoint: inp['api_endpoint'] ? String(inp['api_endpoint']) : undefined,
            content_types: Array.isArray(inp['content_types']) ? inp['content_types'].map(String) : [],
            relevance_score: inp['relevance_score'] ? Number(inp['relevance_score']) : 0,
          });

          return { ok: true, program_id: program.id, program_name: program.program_name };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: msg };
        }
      },
    },
    {
      name: 'affiliate_program_update',
      description: 'Update an affiliate program (status, commission rate, etc.)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          program_id: { type: 'string', description: 'Program ID' },
          approval_status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected', 'active'],
            description: 'Update approval status',
          },
          commission_rate: {
            type: 'number',
            description: 'Update commission rate',
          },
          relevance_score: {
            type: 'number',
            description: 'Update relevance score (0-10)',
          },
          content_types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Update content types',
          },
        },
        required: ['program_id'],
      },
      execute: async (input: unknown) => {
        const principal = tryCurrentPrincipal();
        if (!principal?.user_id) return { error: 'Not authenticated' };

        const inp = input as Record<string, unknown>;
        const programId = String(inp['program_id'] ?? '');

        try {
          const updateData: Partial<AffiliateProgram> = {};
          if (inp['approval_status']) {
            updateData.approval_status = String(inp['approval_status']) as AffiliateProgram['approval_status'];
          }
          if (inp['commission_rate']) {
            updateData.commission_rate = Number(inp['commission_rate']);
          }
          if (inp['relevance_score']) {
            updateData.relevance_score = Number(inp['relevance_score']);
          }
          if (Array.isArray(inp['content_types'])) {
            updateData.content_types = inp['content_types'].map(String);
          }

          const program = await db.updateProgram(principal.user_id, programId, updateData);

          if (!program) return { error: 'Program not found' };
          return { ok: true, program_name: program.program_name };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: msg };
        }
      },
    },
    {
      name: 'affiliate_credential_store',
      description: 'Store API key, affiliate ID, or tracking code in secure vault',
      inputSchema: {
        type: 'object' as const,
        properties: {
          program_id: { type: 'string', description: 'Program ID' },
          credential_type: {
            type: 'string',
            enum: ['api_key', 'affiliate_id', 'tracking_code', 'custom'],
            description: 'Type of credential',
          },
          vault_key: {
            type: 'string',
            description: 'Vault storage key for the encrypted credential value',
          },
        },
        required: ['program_id', 'credential_type', 'vault_key'],
      },
      execute: async (input: unknown) => {
        const principal = tryCurrentPrincipal();
        if (!principal?.user_id) return { error: 'Not authenticated' };

        const inp = input as Record<string, unknown>;
        const programId = String(inp['program_id'] ?? '');
        const credentialType = String(inp['credential_type'] ?? '');
        const vaultKey = String(inp['vault_key'] ?? '');

        try {
          const program = await db.getProgramById(programId, principal.user_id);
          if (!program) return { error: 'Program not found' };

          await db.storeCredential(principal.user_id, programId, credentialType, vaultKey);
          return { ok: true, program_name: program.program_name, credential_type: credentialType };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: msg };
        }
      },
    },
    {
      name: 'affiliate_link_generate',
      description: 'Generate an affiliate link for a program and content piece',
      inputSchema: {
        type: 'object' as const,
        properties: {
          program_id: { type: 'string', description: 'Program ID' },
          content_id: {
            type: 'string',
            description: 'Content ID (video, article, etc.)',
          },
          content_type: {
            type: 'string',
            enum: ['video', 'article', 'post', 'podcast', 'book', 'other'],
            description: 'Type of content',
          },
          custom_params: {
            type: 'object',
            description: 'Custom parameters for URL encoding',
          },
        },
        required: ['program_id', 'content_type'],
      },
      execute: async (input: unknown) => {
        const principal = tryCurrentPrincipal();
        if (!principal?.user_id) return { error: 'Not authenticated' };

        const inp = input as Record<string, unknown>;
        const programId = String(inp['program_id'] ?? '');
        const contentId = inp['content_id'] ? String(inp['content_id']) : null;
        const contentType = String(inp['content_type'] ?? 'other');

        try {
          const program = await db.getProgramById(programId, principal.user_id);
          if (!program) return { error: 'Program not found' };

          const credentials = await db.getCredentials(principal.user_id, programId);
          if (credentials.length === 0) {
            return { error: 'No credentials stored for this program' };
          }

          const generatedLink = await generateLink(program, credentials, contentId, inp['custom_params'], services);

          await db.recordLink(
            principal.user_id,
            programId,
            contentId,
            contentType,
            generatedLink,
            program.link_format,
          );

          return {
            ok: true,
            affiliate_link: generatedLink,
            program_name: program.program_name,
            content_id: contentId,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: msg };
        }
      },
    },
    {
      name: 'affiliate_link_suggest',
      description:
        'Suggest relevant affiliate programs for content type (e.g., VPN article → NordVPN, Skillshare tutorial → Skillshare)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content_type: {
            type: 'string',
            enum: ['video', 'article', 'post', 'podcast', 'book', 'other'],
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Keywords from the content title/description',
          },
        },
        required: ['content_type'],
      },
      execute: async (input: unknown) => {
        const principal = tryCurrentPrincipal();
        if (!principal?.user_id) return { error: 'Not authenticated' };

        const inp = input as Record<string, unknown>;
        const contentType = String(inp['content_type'] ?? 'other');
        const keywords = Array.isArray(inp['keywords'])
          ? inp['keywords'].map((k) => String(k).toLowerCase())
          : [];

        try {
          const programs = await db.listPrograms(principal.user_id);
          const activePrograms = programs.filter((p) => p.approval_status === 'active');

          const suggested = suggestPrograms(activePrograms, contentType, keywords);

          return {
            content_type: contentType,
            suggestions: suggested.map((p) => ({
              program_name: p.program_name,
              provider: p.provider,
              category: p.category,
              commission_rate: p.commission_rate,
              relevance_score: p.relevance_score,
            })),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { error: msg };
        }
      },
    },
  ];
}

function appendQueryParam(baseUrl: string, paramName: string, paramValue: string): string {
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}${paramName}=${encodeURIComponent(paramValue)}`;
}

async function generateLink(
  program: any,
  credentials: any[],
  contentId: string | null,
  customParams?: any,
  services?: any,
): Promise<string> {
  const vault = services?.Vault;

  async function getCredentialValue(cred: any): Promise<string> {
    if (!vault) return cred.key_vault_key;
    try {
      const resolved = await vault.resolve(`\${${cred.key_vault_key}}`);
      return resolved || cred.key_vault_key;
    } catch {
      return cred.key_vault_key;
    }
  }

  const linkGenerators: Record<string, (prog: any, creds: any[], cid: string | null) => Promise<string>> = {
    url: async (prog: any, creds: any[], cid: string | null) => {
      const affiliateIdCred =
        creds.find((c) => c.credential_type === 'affiliate_id') ||
        creds.find((c) => c.credential_type === 'api_key') ||
        creds.find((c) => c.credential_type === 'custom');

      if (!affiliateIdCred) throw new Error('Affiliate ID, API key, or custom credential required for URL format');

      const signupUrl = prog.signup_url ? String(prog.signup_url).trim() : '';
      const apiEndpoint = prog.api_endpoint ? String(prog.api_endpoint).trim() : '';
      const baseUrl = signupUrl || apiEndpoint;

      if (!baseUrl || typeof baseUrl !== 'string') {
        throw new Error('Valid signup URL or API endpoint required for URL format');
      }

      const affiliateIdValue = await getCredentialValue(affiliateIdCred);
      if (!affiliateIdValue) {
        throw new Error('Credential value is empty or invalid');
      }

      const providerParamMap: Record<string, string> = {
        amazon: 'tag',
        kdp: 'tag',
        kobo: 'affiliate',
      };
      const paramName = providerParamMap[prog.provider] || 'ref';

      return appendQueryParam(baseUrl, paramName, affiliateIdValue);
    },

    api: async (prog: any, creds: any[], cid: string | null) => {
      const apiEndpoint = prog.api_endpoint ? String(prog.api_endpoint).trim() : '';
      if (!apiEndpoint || typeof apiEndpoint !== 'string') {
        throw new Error('Valid API endpoint required for API format');
      }

      const apiKeyCred = creds.find((c) => c.credential_type === 'api_key');
      if (!apiKeyCred) {
        throw new Error('API key credential required for API format');
      }

      // Security: CRITICAL - API keys must NEVER be embedded in URLs or query parameters.
      // URLs are logged in browser history, server logs, and transmitted in Referer headers.
      // Instead, callers MUST:
      // 1. Use the API key in the Authorization header (POST/GET with Bearer token), or
      // 2. Send the API key in the request body (POST only), or
      // 3. Call this endpoint only from server-side code with the key in memory.
      // Never expose this endpoint in client-side code with the credential.
      return apiEndpoint;
    },

    pixel: async (prog: any, creds: any[], cid: string | null) => {
      const pixelEndpoint = prog.api_endpoint ? String(prog.api_endpoint).trim() : '';
      if (!pixelEndpoint || typeof pixelEndpoint !== 'string') {
        throw new Error('Valid API endpoint (pixel src) required for pixel format');
      }

      const trackingCodeCred = creds.find((c) => c.credential_type === 'tracking_code');
      if (!trackingCodeCred) throw new Error('Tracking code credential required for pixel format');

      const trackingCodeValue = await getCredentialValue(trackingCodeCred);

      // Security WARNING: Tracking code and content ID are exposed in the pixel URL.
      // NEVER include PII, API keys, or sensitive user data in tracking parameters.
      // Risks: URL visible in browser history, server logs, and Referer headers.
      // For sensitive tracking data, implement this on the server-side instead:
      // 1. Generate the pixel URL on your backend with the tracking code
      // 2. Call the pixel endpoint from your backend, never expose it to clients
      // 3. Return a placeholder or 1x1 transparent GIF to the client
      let pixelUrl = appendQueryParam(pixelEndpoint, 'code', trackingCodeValue);
      pixelUrl = appendQueryParam(pixelUrl, 'content', cid || '');
      return `<img src="${pixelUrl}" width="1" height="1" alt="" />`;
    },
  };

  const generator = linkGenerators[program.link_format];
  if (!generator) {
    throw new Error(`Unknown link format: ${program.link_format}`);
  }

  return generator(program, credentials, contentId);
}

function suggestPrograms(programs: any[], contentType: string, keywords: string[]): any[] {
  const keywordMatches: Record<string, number> = {};

  // Provider-to-content-type affinity: programs that naturally fit certain content types
  const providerAffinity: Record<string, Record<string, number>> = {
    kobo: { article: 2, book: 3, post: 1 },
    'apple-books': { article: 2, book: 3, post: 1 },
    'google-play': { article: 2, book: 3, post: 1 },
    amazon: { article: 2, book: 3, post: 1 },
    kdp: { article: 2, book: 3, post: 1 },
    scribd: { article: 2, book: 3, post: 1 },
    audible: { article: 1, book: 2, post: 0 },
    skillshare: { article: 2, video: 3, post: 1 },
    udemy: { article: 2, video: 3, post: 1 },
    coursera: { article: 2, video: 3, post: 1 },
    nordvpn: { article: 2, video: 2, post: 1 },
    expressvpn: { article: 2, video: 2, post: 1 },
    fiverr: { article: 2, post: 2, video: 1 },
    upwork: { article: 2, post: 2, video: 1 },
  };

  function matchScore(text: string, keyword: string): number {
    const lower = text.toLowerCase();
    if (!lower.includes(keyword)) return 0;

    // Exact word match (word boundary)
    const wordBoundary = new RegExp(`\\b${keyword}\\b`);
    if (wordBoundary.test(lower)) return 3;

    // Substring match starting at word boundary
    const boundaryStart = new RegExp(`\\b${keyword}`);
    if (boundaryStart.test(lower)) return 2;

    // Any substring match
    return 1;
  }

  for (const program of programs) {
    let score = (program.relevance_score || 0) * 1.5;

    // Strong boost for exact content type match
    if (program.content_types?.includes(contentType)) {
      score += 5;
    }

    // Provider affinity boost
    const providerLower = (program.provider || '').toLowerCase();
    const affinityBoost = providerAffinity[providerLower]?.[contentType] || 0;
    if (affinityBoost > 0) {
      score += affinityBoost;
    }

    // Commission rate as monetization signal (small boost)
    if (program.commission_rate && program.commission_rate > 10) {
      score += 0.5;
    }

    // Keyword matching with higher weights
    for (const keyword of keywords) {
      const nameScore = matchScore(program.program_name, keyword);
      const providerScore = matchScore(program.provider, keyword);
      const categoryScore = matchScore(program.category || '', keyword) ? 1 : 0;
      const tagScore = program.metadata?.tags?.reduce((max: number, t: string) => {
        return Math.max(max, matchScore(t, keyword));
      }, 0) || 0;

      score += (nameScore * 4) + (providerScore * 3) + (categoryScore * 2) + tagScore;
    }

    keywordMatches[program.id] = score;
  }

  return programs
    .filter((p) => keywordMatches[p.id] > 0)
    .sort((a, b) => (keywordMatches[b.id] || 0) - (keywordMatches[a.id] || 0))
    .slice(0, 5);
}
