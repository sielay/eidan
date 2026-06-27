// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotTool, MatbotServices } from '@matatbread/matbot-plugin-api';
import { tryCurrentPrincipal } from '@matatbread/matbot-plugin-api';
import type { AffiliateDb } from './db.js';

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
          const program = await db.updateProgram(principal.user_id, programId, {
            ...(inp['approval_status'] ? { approval_status: String(inp['approval_status']) as any } : {}),
            ...(inp['commission_rate'] ? { commission_rate: Number(inp['commission_rate']) } : {}),
            ...(inp['relevance_score'] ? { relevance_score: Number(inp['relevance_score']) } : {}),
            ...(Array.isArray(inp['content_types']) ? { content_types: inp['content_types'].map(String) } : {}),
          } as any);

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

  const params = {
    ...customParams,
  };

  switch (program.link_format) {
    case 'url':
      const affiliateIdCred =
        credentials.find((c) => c.credential_type === 'affiliate_id') ||
        credentials.find((c) => c.credential_type === 'api_key') ||
        credentials.find((c) => c.credential_type === 'custom');

      if (!affiliateIdCred) throw new Error('Affiliate ID, API key, or custom credential required for URL format');

      const affiliateIdValue = await getCredentialValue(affiliateIdCred);
      const baseUrl = program.signup_url || program.api_endpoint || '';

      if (!baseUrl) throw new Error('Signup URL or API endpoint required for URL format');

      const separator = baseUrl.includes('?') ? '&' : '?';

      if (program.provider === 'amazon' || program.provider === 'kdp') {
        return `${baseUrl}${separator}tag=${encodeURIComponent(affiliateIdValue)}`;
      } else if (program.provider === 'kobo') {
        return `${baseUrl}${separator}affiliate=${encodeURIComponent(affiliateIdValue)}`;
      } else {
        return `${baseUrl}${separator}ref=${encodeURIComponent(affiliateIdValue)}`;
      }

    case 'api':
      const apiKeyCred = credentials.find((c) => c.credential_type === 'api_key');
      if (!program.api_endpoint) throw new Error('API endpoint required for API format');

      if (apiKeyCred) {
        const apiKeyValue = await getCredentialValue(apiKeyCred);
        // WARNING: API key is exposed in URL. Use only in server-side requests, never client-side.
        // If the API supports it, prefer POST requests with key in request body.
        return `${program.api_endpoint}?key=${encodeURIComponent(apiKeyValue)}`;
      }
      return program.api_endpoint;

    case 'pixel':
      const trackingCodeCred = credentials.find((c) => c.credential_type === 'tracking_code');
      if (!trackingCodeCred) throw new Error('Tracking code credential required for pixel format');
      if (!program.api_endpoint) throw new Error('API endpoint required for pixel format');

      const trackingCodeValue = await getCredentialValue(trackingCodeCred);
      // WARNING: Tracking code and content ID are exposed in pixel URL (logs, referrer, browser history).
      // Ensure tracked data is non-sensitive. For highly sensitive tracking, use server-side requests instead.
      return `<img src="${program.api_endpoint}?code=${encodeURIComponent(trackingCodeValue)}&content=${encodeURIComponent(contentId || '')}" width="1" height="1" />`;

    default:
      throw new Error(`Unknown link format: ${program.link_format}`);
  }
}

function suggestPrograms(programs: any[], contentType: string, keywords: string[]): any[] {
  const keywordMatches: Record<string, number> = {};

  for (const program of programs) {
    let score = program.relevance_score || 0;

    if (program.content_types.includes(contentType)) {
      score += 2;
    }

    for (const keyword of keywords) {
      if (program.program_name.toLowerCase().includes(keyword)) score += 3;
      if (program.provider.toLowerCase().includes(keyword)) score += 3;
      if (program.metadata?.tags?.some((t: string) => t.toLowerCase().includes(keyword))) score += 1;
    }

    keywordMatches[program.id] = score;
  }

  return programs
    .filter((p) => keywordMatches[p.id] > 0)
    .sort((a, b) => (keywordMatches[b.id] || 0) - (keywordMatches[a.id] || 0))
    .slice(0, 5);
}
