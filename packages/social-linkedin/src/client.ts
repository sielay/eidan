// SPDX-License-Identifier: AGPL-3.0-or-later
// LinkedIn API v2 client. Constructed with an already-resolved access token (the connections kit
// resolves the per-account token before the tools build a client) — this class never touches the
// vault. Posting supports an optional image with strict SSRF mitigation (HTTPS-only, domain
// whitelist, DNS-rebinding guard, per-redirect re-validation, size + content-type checks).
import { lookup } from 'node:dns';
import { promisify } from 'node:util';
import type { LinkedInUGCPostRequest, LinkedInAssetRegisterResponse } from './types.js';

const dnsLookup = promisify(lookup);

const API_BASE = 'https://api.linkedin.com/v2';
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const IMAGE_FETCH_TIMEOUT_MS = 30000; // 30 seconds
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// Whitelist of trusted image hosting domains for SSRF mitigation
const ALLOWED_IMAGE_DOMAINS = [
  'cdn.jsdelivr.net',
  'res.cloudinary.com',
  'images.unsplash.com',
  'images.pexels.com',
  'images.pixabay.com',
  'imgur.com',
  'i.imgur.com',
  'giphy.com',
  'media.giphy.com',
  'cdn.shopify.com',
  'images.ctfassets.net',
  // Allow specific domains; for custom domains, operators should extend this list
];

const REST_BASE = 'https://api.linkedin.com/rest';
const LINKEDIN_VERSION = '202506';

export class LinkedInClient {
  private accessToken: string;
  // The author URN to act as: `urn:li:person:{id}` (member) or `urn:li:organization:{id}` (Page/org).
  private author: string;
  // 'member' | 'organization' — drives which identity/read endpoints apply.
  private type: string;
  private handle: string;

  constructor(accessToken: string, opts?: { author?: string; type?: string; handle?: string }) {
    this.accessToken = accessToken;
    this.author = opts?.author ?? '';
    this.type = opts?.type ?? '';
    this.handle = opts?.handle ?? '';
  }

  private isPrivateIp(ip: string): boolean {
    // RFC1918 private ranges and loopback for IPv4
    const ipv4Patterns = [
      /^127\./,           // loopback (127.0.0.0/8)
      /^10\./,            // private (10.0.0.0/8)
      /^172\.(1[6-9]|2\d|3[01])\./, // private (172.16.0.0/12)
      /^192\.168\./,      // private (192.168.0.0/16)
      /^169\.254\./,      // link-local (169.254.0.0/16)
    ];

    // IPv6 private/reserved ranges
    const ipv6Patterns = [
      /^::1$/,            // loopback
      /^f[cd][0-9a-f]{2}:/,           // unique local unicast (fc00::/7)
      /^fe[89ab][0-9a-f]:/,           // link-local unicast (fe80::/10)
      /^::ffff:127\./,    // IPv4-mapped loopback
      /^::ffff:10\./,     // IPv4-mapped private
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./,  // IPv4-mapped private
      /^::ffff:192\.168\./, // IPv4-mapped private
      /^::ffff:169\.254\./, // IPv4-mapped link-local
    ];

    const isPrivateIpv4 = ipv4Patterns.some((pattern) => pattern.test(ip));
    const isPrivateIpv6 = ipv6Patterns.some((pattern) => pattern.test(ip));

    return isPrivateIpv4 || isPrivateIpv6;
  }

  private isAllowedImageDomain(hostname: string): boolean {
    // Check if hostname exactly matches or ends with a whitelisted domain
    return ALLOWED_IMAGE_DOMAINS.some((domain) =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
  }

  private async validateImageUrl(imageUrl: string): Promise<boolean> {
    try {
      const url = new URL(imageUrl);
      // Only allow HTTPS to prevent SSRF via HTTP
      if (url.protocol !== 'https:') {
        return false;
      }

      const hostname = url.hostname;

      // Check against whitelist first for faster rejection of non-whitelisted domains
      if (!this.isAllowedImageDomain(hostname)) {
        return false;
      }

      // Reject if hostname itself is a private IP
      if (this.isPrivateIp(hostname)) {
        return false;
      }

      // Resolve hostname to IP and validate all resolved IPs are not private
      // Additional DNS validation layer to prevent DNS rebinding attacks
      try {
        const resolvedAddresses = await dnsLookup(hostname, { all: true });
        for (const { address } of resolvedAddresses) {
          if (this.isPrivateIp(address)) {
            return false;
          }
        }
      } catch (error) {
        // If DNS resolution fails, reject for safety
        console.error('DNS resolution failed for image URL:', hostname, error);
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  private async fetchImageWithRedirectValidation(imageUrl: string): Promise<Response> {
    // Validate initial URL before making the first request
    if (!(await this.validateImageUrl(imageUrl))) {
      throw new Error('Image URL must be HTTPS and not point to private/internal networks');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

    try {
      let currentUrl = imageUrl;
      let redirectCount = 0;
      const maxRedirects = 5;

      // Manual redirect handling allows SSRF validation at each step, preventing attacks
      // where a redirect chain could lead to a private/internal network (e.g., via a
      // whitelisted domain redirecting to 127.0.0.1). This is critical for security.
      while (redirectCount < maxRedirects) {
        const response = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: 'manual',
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            throw new Error(`Redirect with no Location header at ${currentUrl}`);
          }

          const resolvedLocation = new URL(location, currentUrl).toString();
          if (!(await this.validateImageUrl(resolvedLocation))) {
            throw new Error(`Redirect to invalid URL: ${resolvedLocation}`);
          }

          currentUrl = resolvedLocation;
          redirectCount++;
        } else {
          return response;
        }
      }

      throw new Error(`Too many redirects (more than ${maxRedirects})`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async request<T>(
    endpoint: string,
    method: string = 'GET',
    body?: Record<string, unknown>,
    opts?: { versioned?: boolean }
  ): Promise<{ data?: T; error?: string }> {
    try {
      // Versioned Community Management endpoints live under /rest with a LinkedIn-Version header; the
      // legacy /v2 endpoints (e.g. userinfo) must NOT carry a version header.
      const url = `${opts?.versioned ? REST_BASE : API_BASE}${endpoint}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      };
      if (opts?.versioned) {
        headers['LinkedIn-Version'] = LINKEDIN_VERSION;
        headers['X-Restli-Protocol-Version'] = '2.0.0';
      }
      const options: RequestInit = { method, headers };

      if (body) {
        options.body = JSON.stringify(body);
      }

      const res = await fetch(url, options);

      if (!res.ok) {
        const errorText = await res.text();
        return {
          error: `LinkedIn API error: ${res.status} ${errorText}`,
        };
      }

      const data = (await res.json()) as T;
      return { data };
    } catch (err) {
      return {
        error: `Request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  async getProfile(): Promise<{
    profile?: { id: string; name: string; kind: string; headline?: string; picture?: string; email?: string };
    error?: string;
  }> {
    const isOrg = this.type === 'organization' || this.author.startsWith('urn:li:organization:');
    if (isOrg) {
      // Member /me & /userinfo don't apply to an org connection; look the organization up (best effort —
      // needs r_organization_admin/rw_organization_admin), else return the identity we already hold.
      const id = this.author.split(':').pop() ?? '';
      const r = await this.request<{ localizedName?: string; vanityName?: string }>(
        `/organizations/${id}`,
        'GET',
        undefined,
        { versioned: true },
      );
      if (r.data?.localizedName) {
        return {
          profile: {
            id: this.author,
            name: r.data.localizedName,
            kind: 'organization',
            ...(r.data.vanityName ? { headline: r.data.vanityName } : {}),
          },
        };
      }
      return { profile: { id: this.author || id, name: this.handle || this.author || 'organization', kind: 'organization' } };
    }
    // Member: OpenID userinfo (the modern replacement for /me, which the OpenID token can't access).
    const r = await this.request<{ sub?: string; name?: string; email?: string; picture?: string }>('/userinfo');
    if (r.error) return { error: r.error };
    const d = r.data ?? {};
    return {
      profile: {
        id: d.sub ?? this.author,
        name: d.name ?? this.handle ?? '',
        kind: 'member',
        ...(d.picture ? { picture: d.picture } : {}),
        ...(d.email ? { email: d.email } : {}),
      },
    };
  }

  private async registerAsset(imageUrl: string): Promise<{ urn?: string; error?: string }> {
    try {
      // Validate imageUrl to prevent SSRF before making any external requests
      if (!(await this.validateImageUrl(imageUrl))) {
        return { error: 'Image URL must be HTTPS and not point to private/internal networks' };
      }

      const assetRegisterPayload = {
        registerRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          serviceRelationships: [
            {
              relationshipType: 'OWNER',
              identifier: 'urn:li:userGeneratedContent',
            },
          ],
        },
      };

      const registerResult = await this.request<LinkedInAssetRegisterResponse>('/assets', 'POST', assetRegisterPayload);
      if (registerResult.error) {
        return { error: registerResult.error };
      }

      if (!registerResult.data?.value) {
        return { error: 'Failed to register image asset' };
      }

      const uploadMechanism = registerResult.data.value.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'];
      if (!uploadMechanism?.uploadUrl) {
        return { error: 'Missing upload URL from asset registration response' };
      }

      const urn = registerResult.data.value.mediaReferenceObjectId;
      if (!urn) {
        return { error: 'Missing media reference object ID from asset registration response' };
      }

      let imageBuffer: Uint8Array;
      let contentType = 'application/octet-stream';
      try {
        const imageResponse = await this.fetchImageWithRedirectValidation(imageUrl);

        if (!imageResponse.ok) {
          return { error: `Failed to fetch image from URL: ${imageResponse.status}` };
        }

        // Validate content-type header before downloading body
        const responseContentType = imageResponse.headers.get('content-type');
        if (!responseContentType || !ALLOWED_IMAGE_TYPES.some((type) => responseContentType.includes(type))) {
          return { error: `Invalid image content-type: ${responseContentType || 'not specified'}. Expected image/jpeg, image/png, image/gif, or image/webp` };
        }

        contentType = responseContentType;

        // Check Content-Length header before downloading to prevent DoS
        const contentLengthHeader = imageResponse.headers.get('content-length');
        if (contentLengthHeader) {
          const contentLength = parseInt(contentLengthHeader, 10);
          if (isNaN(contentLength) || contentLength > MAX_IMAGE_SIZE) {
            return { error: `Image exceeds maximum size of ${MAX_IMAGE_SIZE / (1024 * 1024)}MB` };
          }
        }

        const arrayBuffer = await imageResponse.arrayBuffer();

        // Final size check to ensure no bypass of Content-Length check
        if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
          return { error: `Image exceeds maximum size of ${MAX_IMAGE_SIZE / (1024 * 1024)}MB` };
        }

        imageBuffer = new Uint8Array(arrayBuffer);
      } catch (fetchErr) {
        if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
          return { error: `Image fetch timeout (exceeded ${IMAGE_FETCH_TIMEOUT_MS / 1000}s)` };
        }
        if (fetchErr instanceof Error && fetchErr.message.includes('not point to private/internal networks')) {
          return { error: fetchErr.message };
        }
        return {
          error: `Failed to download image: ${fetchErr instanceof Error ? fetchErr.message : 'Unknown error'}`,
        };
      }

      const uploadResponse = await fetch(uploadMechanism.uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': contentType,
        },
        body: imageBuffer as unknown as BodyInit,
      });

      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        return { error: `Image upload failed: ${uploadResponse.status} ${errorText}` };
      }

      return { urn };
    } catch (err) {
      return {
        error: `Asset registration failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  async post(text: string, imageUrl?: string): Promise<{ id?: string; error?: string }> {
    // Member connections post as the person URN; organization (Page) connections post as the org URN
    // (set on the client). Only fall back to /me when no author was supplied (legacy member token).
    let author = this.author;
    if (!author) {
      const userResult = await this.request<{ id: string }>('/me');
      if (userResult.error || !userResult.data?.id) {
        return { error: 'Failed to get user ID — for an organization connection this needs the org URN' };
      }
      author = `urn:li:person:${userResult.data.id}`;
    }

    let mediaUrn: string | undefined;
    if (imageUrl) {
      const assetResult = await this.registerAsset(imageUrl);
      if (assetResult.error) {
        return { error: assetResult.error };
      }
      mediaUrn = assetResult.urn;
    }

    const postPayload: LinkedInUGCPostRequest = {
      author,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text,
          },
          shareMediaCategory: mediaUrn ? 'IMAGE' : 'NONE',
          ...(mediaUrn && {
            media: [
              {
                status: 'READY',
                media: mediaUrn,
              },
            ],
          }),
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    const result = await this.request<{ id: string }>('/ugcPosts', 'POST', postPayload as unknown as Record<string, unknown>);
    if (result.error) {
      return { error: result.error };
    }
    if (!result.data?.id) {
      return { error: 'No post ID received' };
    }
    return { id: result.data.id };
  }

  // Recent posts published BY this connection (the member's own posts, or the organization's). LinkedIn
  // has no "read another member's feed" API and no public post-search API, so this lists this account's
  // own authored posts via the versioned Community Management /rest/posts?q=author endpoint.
  //
  // LIMITATION: Engagement data (likes, comments) is unavailable due to permission restrictions.
  // The Community Management API standard tier (currently in development tier) requires the
  // r_member_social_feed permission (restricted) to read reactions. Once the operator's account
  // is upgraded to standard tier and r_member_social_feed is granted, engagement data can be
  // fetched via a separate Reactions API call per post (see upgrade path below).
  //
  // UPGRADE PATH (once standard tier + r_member_social_feed is approved):
  // 1. Fetch post IDs via /posts?q=author (current endpoint)
  // 2. For each post, call /reactions?q=post with the post URN to get likes/reactions count
  // 3. Parse reaction types (LIKE, COMMENT_LIKE, etc.) to populate likes/comments fields
  // 4. See: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api
  async listFeed(limit: number = 20): Promise<{ posts?: Array<{ id: string; text: string; likes: number; comments: number; engagement_data_available: boolean }>; error?: string }> {
    if (!this.author) {
      return { error: 'this connection has no author URN yet — reconnect it (org connections need rw_organization_admin)' };
    }
    const author = encodeURIComponent(this.author);
    const result = await this.request<{ elements?: Array<{ id?: string; commentary?: string }> }>(
      `/posts?q=author&author=${author}&count=${Math.min(limit, 100)}&sortBy=LAST_MODIFIED`,
      'GET',
      undefined,
      { versioned: true },
    );
    if (result.error) {
      return { error: result.error };
    }
    // TODO: Once standard tier + r_member_social_feed permission is granted:
    // 1. Set engagement_data_available to true
    // 2. For each post, call /reactions?q=post with the post URN to fetch engagement
    // 3. Parse reaction types (LIKE, COMMENT_LIKE, etc.) to populate likes/comments
    // See the upgrade path documentation above and https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api
    const posts = (result.data?.elements ?? []).map((p) => ({
      id: p.id ?? '',
      text: p.commentary ?? '',
      likes: 0,
      comments: 0,
      engagement_data_available: false,
    }));
    return { posts };
  }
}
