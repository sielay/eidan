// SPDX-License-Identifier: AGPL-3.0-or-later
// LinkedIn OAuth2 adapter for the connections kit. LinkedIn issues long-lived access tokens (no
// refresh in the member-social flow); identity comes from the OpenID `userinfo` endpoint.
//
// LinkedIn gates scopes by the app's enabled PRODUCTS, and some (e.g. Community Management / Pages)
// can't be combined with Sign-In/Share in one app — so scopes are configured PER APP in the UI. This
// default suits a "Sign In with LinkedIn using OpenID Connect" + "Share on LinkedIn" app; a Pages app
// would override with the organization scopes (e.g. r_organization_social w_organization_social
// rw_organization_admin). NB the legacy `r_liteprofile` is retired — modern apps use openid/profile.
import type { OAuthAdapter } from '@eidandev/connections-kit';

export const LINKEDIN_PROVIDER = 'linkedin';

export const linkedinAdapter: OAuthAdapter = {
  provider: LINKEDIN_PROVIDER,
  flavor: 'oauth2',
  scopes: ['openid', 'profile', 'email', 'w_member_social'],
  usesRefresh: false,
  // A LinkedIn app carries EITHER Sign-In/Share products OR the Community Management (Pages) product —
  // LinkedIn won't let them mix. So a connection is one of two kinds, each probed differently and
  // backed by a different app (with its own scopes): a member profile, or an organization (Page).
  connectionTypes: [
    { value: 'member', label: 'Profile (member)' },
    { value: 'organization', label: 'Page / Organization' },
  ],
  endpoints: () => ({
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
  }),
  // List the organizations (Pages) this member administers, so the UI can offer a picker after connect.
  async listTargets(accessToken: string): Promise<Array<{ id: string; label: string }>> {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202506',
      'X-Restli-Protocol-Version': '2.0.0',
    };
    let urns: string[] = [];
    try {
      const r = await fetch(
        'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=50',
        { headers, signal: AbortSignal.timeout(15_000) },
      );
      if (r.status !== 200) return [];
      const j = (await r.json().catch(() => ({}))) as { elements?: Array<{ organization?: string }> };
      urns = (j.elements ?? []).map((e) => e.organization ?? '').filter(Boolean);
    } catch {
      return [];
    }
    const out: Array<{ id: string; label: string }> = [];
    for (const urn of urns.slice(0, 50)) {
      const id = urn.split(':').pop() ?? '';
      let label = `org ${id}`;
      try {
        const rr = await fetch(`https://api.linkedin.com/rest/organizations/${id}`, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        if (rr.status === 200) {
          const jj = (await rr.json().catch(() => ({}))) as { localizedName?: string; vanityName?: string };
          label = jj.localizedName || jj.vanityName || label;
        }
      } catch {
        // keep the fallback label
      }
      out.push({ id: urn, label });
    }
    return out;
  },
  async fetchIdentity(accessToken: string, opts?: { host?: string; type?: string; target?: string }) {
    // Organization (Pages/Community) apps have no openid/profile scope, so /userinfo 401s. A member may
    // administer SEVERAL pages, so each connection binds to ONE specific organization (the `target`
    // entered on connect — numeric id, URN, vanity, or company URL). Without a target we fall back to
    // the first admin'd org (ambiguous when there are many).
    if (opts?.type === 'organization') {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202506',
        'X-Restli-Protocol-Version': '2.0.0',
      };
      const target = (opts.target ?? '').trim();
      let orgUrn = '';
      if (target) {
        if (/^\d+$/.test(target)) orgUrn = `urn:li:organization:${target}`;
        else if (target.startsWith('urn:li:organization:')) orgUrn = target;
        else {
          // strip a company/organization URL down to its vanity (or numeric) segment, then resolve.
          const seg = target
            .replace(/^https?:\/\/[^/]+\/(company|organization)\//i, '')
            .replace(/[/?#].*$/, '')
            .trim();
          if (/^\d+$/.test(seg)) orgUrn = `urn:li:organization:${seg}`;
          else if (seg) {
            try {
              const r = await fetch(
                `https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(seg)}`,
                { headers, signal: AbortSignal.timeout(15_000) },
              );
              if (r.status === 200) {
                const j = (await r.json().catch(() => ({}))) as { elements?: Array<{ id?: number | string }> };
                const id = j.elements?.[0]?.id;
                if (id != null) orgUrn = `urn:li:organization:${id}`;
              }
            } catch {
              // fall through
            }
          }
        }
      }
      if (orgUrn) {
        const id = orgUrn.split(':').pop() ?? '';
        try {
          const r = await fetch(`https://api.linkedin.com/rest/organizations/${id}`, {
            headers,
            signal: AbortSignal.timeout(15_000),
          });
          if (r.status === 200) {
            const j = (await r.json().catch(() => ({}))) as { localizedName?: string; vanityName?: string };
            return { handle: j.localizedName || j.vanityName || `org ${id}`, id: orgUrn };
          }
        } catch {
          // fall through
        }
        return { handle: `org ${id}`, id: orgUrn };
      }
      // No target → first admin'd org (ambiguous when the member administers several).
      try {
        const r = await fetch(
          'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=10',
          { headers, signal: AbortSignal.timeout(15_000) },
        );
        if (r.status === 200) {
          const j = (await r.json().catch(() => ({}))) as { elements?: Array<{ organization?: string }> };
          const org = j.elements?.[0]?.organization ?? '';
          return { handle: org || 'organization', id: org };
        }
      } catch {
        // fall through
      }
      return { handle: '', id: '' };
    }
    try {
      const r = await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await r.json().catch(() => ({}))) as { sub?: string; name?: string; email?: string };
      return { handle: j.name ?? j.email ?? j.sub ?? '', id: j.sub ?? '' };
    } catch {
      return { handle: '', id: '' };
    }
  },
};
