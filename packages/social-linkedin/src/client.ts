// SPDX-License-Identifier: AGPL-3.0-or-later
import { lookup } from 'node:dns';
import { promisify } from 'node:util';
import type { ToolContext } from '@matatbread/matbot-plugin-api';
import { secretOpt } from './vault.js';
import type { LinkedInPost, LinkedInProfileResponse, LinkedInFeedResponse, LinkedInUGCPostRequest, LinkedInAssetRegisterResponse } from './types.js';

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

export class LinkedInClient {
  private ctx: ToolContext;
  private accessToken: string;

  constructor(ctx: ToolContext, accessToken: string) {
    this.ctx = ctx;
    this.accessToken = accessToken;
  }

  private isPrivateIp(ip: string): boolean {
    // RFC1918 private ranges and loopback for IPv4.
    // Covers common reserved ranges; note that some carrier-grade NAT and future-reserved ranges
    // may not be included. For high-security deployments, consider using a well-maintained IP validation library.
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
      /^f[c-d][0-9a-f]{2}:/,           // unique local unicast (fc00::/7)
      /^fe[8-b][0-9a-f]:/,           // link-local unicast (fe80::/10)
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
      // Only allow HTTPS; explicitly reject other protocols (http, ftp, file, etc.) to prevent SSRF
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

      // Resolve hostname to IP and validate all resolved IPs are not private.
      // Note: DNS rebinding attacks can bypass this validation if DNS records change between lookup
      // and fetch. For very high-security deployments, consider additional mitigations like
      // an image proxy or firewall-level domain whitelist. For typical use, this layered approach
      // (whitelist + private-IP check + DNS validation) provides strong SSRF protection.
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
          if (!location || location.trim() === '') {
            throw new Error(`Redirect with no Location header at ${currentUrl}`);
          }

          // Validate location header before constructing URL to prevent injection attacks.
          // new URL(location, currentUrl) handles relative URLs safely, but malformed
          // location values could still cause issues; validation here catches them.
          let resolvedLocation: string;
          try {
            resolvedLocation = new URL(location, currentUrl).toString();
          } catch (err) {
            throw new Error(`Invalid Location header in redirect: ${location}`);
          }

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
    body?: Record<string, unknown>
  ): Promise<{ data?: T; error?: string }> {
    try {
      const url = `${API_BASE}${endpoint}`;
      const options: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202312',
        },
      };

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

  async getProfile(): Promise<{ profile?: LinkedInProfileResponse; error?: string }> {
    const result = await this.request<LinkedInProfileResponse>('/me');
    if (result.error) {
      return { error: result.error };
    }
    if (!result.data) {
      return { error: 'No profile data received' };
    }
    return { profile: result.data };
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

        // Validate content-type header before downloading body.
        // Use exact matching to prevent loose matching (e.g., image/jpeg-foo should not match image/jpeg).
        // Content-Type may include parameters like "; charset=utf-8", so match the base type only.
        const responseContentType = imageResponse.headers.get('content-type');
        if (!responseContentType) {
          return { error: 'Image response missing content-type header. Expected image/jpeg, image/png, image/gif, or image/webp' };
        }

        const baseContentType = responseContentType.split(';')[0].trim();
        if (!ALLOWED_IMAGE_TYPES.some((type) => baseContentType === type)) {
          return { error: `Invalid image content-type: ${responseContentType}. Expected image/jpeg, image/png, image/gif, or image/webp` };
        }

        contentType = baseContentType;

        // Check Content-Length header before downloading to prevent DoS.
        // If the header is missing or invalid, we still download and check actual size (see below).
        // Note: arrayBuffer() loads the entire image into memory. For very large images, this could
        // cause excessive memory consumption. A streaming approach or temp-file buffer would be more
        // efficient, but requires LinkedIn API support or intermediate storage.
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
        body: imageBuffer,
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
    const userResult = await this.request<{ id: string }>('/me');
    if (userResult.error || !userResult.data?.id) {
      return { error: 'Failed to get user ID' };
    }

    const userId = userResult.data.id;

    let mediaUrn: string | undefined;
    if (imageUrl) {
      const assetResult = await this.registerAsset(imageUrl);
      if (assetResult.error) {
        return { error: assetResult.error };
      }
      mediaUrn = assetResult.urn;
    }

    const postPayload: LinkedInUGCPostRequest = {
      author: `urn:li:person:${userId}`,
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

    const result = await this.request<{ id: string }>('/ugcPosts', 'POST', postPayload);
    if (result.error) {
      return { error: result.error };
    }
    if (!result.data?.id) {
      return { error: 'No post ID received' };
    }
    return { id: result.data.id };
  }

  // Maps a raw LinkedIn post response to a flattened post structure.
  // Text extraction is simplified: we extract description or title only, which may not capture
  // the full complexity of a LinkedIn post (rich text, embedded content, media captions, etc.).
  // This simplified mapping is sufficient for the current tool scope (search, feed listing).
  // If full post content is needed, consider expanding this to handle richer content types.
  // Fallback behavior: empty string for text if both description and title are missing,
  // empty string for author if actor is undefined, and 0 for engagement metrics if not provided.
  private mapPost(post: LinkedInPost): { id: string; text: string; author?: string; likes: number; comments: number } {
    return {
      id: post.id,
      // Prefer description over title; empty string if neither exists
      text: post.content?.description || post.content?.title || '',
      // Actor is optional in API response; undefined if missing (aligns with author?: string type)
      author: post.actor,
      // Default to 0 for missing engagement metrics (expected for posts with no engagement)
      likes: post.likesSummary?.totalLikes ?? 0,
      comments: post.commentsSummary?.totalFirstLevelComments ?? 0,
    };
  }

  async listFeed(limit: number = 20): Promise<{ posts?: Array<{ id: string; text: string; author?: string; likes: number; comments: number }>; error?: string }> {
    const url = `/feed?count=${Math.min(limit, 100)}&sortBy=RECENT`;
    const result = await this.request<LinkedInFeedResponse>(url);

    if (result.error) {
      return { error: result.error };
    }

    const posts = result.data?.elements?.map((post) => this.mapPost(post)) ?? [];

    return { posts };
  }

  async search(query: string, limit: number = 20): Promise<{ posts?: Array<{ id: string; text: string; author?: string; likes: number; comments: number }>; error?: string }> {
    const url = `/search/posts?keywords=${encodeURIComponent(query)}&count=${Math.min(limit, 100)}`;
    const result = await this.request<LinkedInFeedResponse>(url);

    if (result.error) {
      return { error: result.error };
    }

    const posts = result.data?.elements?.map((post) => this.mapPost(post)) ?? [];

    return { posts };
  }
}
