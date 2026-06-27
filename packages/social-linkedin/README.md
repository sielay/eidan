# @eidandev/social-linkedin

LinkedIn Social integration for Eidan: post to LinkedIn, get profile information, and read your own posts via OAuth2.

## Requirements

- **Node.js 18+**: This plugin uses Node.js built-in modules (`node:dns`, `node:util`), so it requires a Node.js runtime. Browser environments are not supported.

## Setup

1. **Create a LinkedIn Developer App**:
   - Visit https://www.linkedin.com/developers/apps
   - Click "Create app"
   - Fill in app details (name, LinkedIn Page, company, legal agreement)
   - Accept terms and create

2. **Generate OAuth2 Access Token**:
   - From your app dashboard, go to the "Auth" tab
   - Generate an OAuth2 Bearer token (for testing, use "Sign in with LinkedIn" credentials)
   - Copy the access token (starts with `ey...`)
   - Note: In production, you'll use OAuth2 flow; for personal use, token-based auth is simpler

3. **Configure Eidan vault secrets**:
   - Via the Settings UI (Connections → LinkedIn Social):
     - **LINKEDIN_ACCESS_TOKEN**: The OAuth2 access token from step 2
   - Or via environment/gitignored `matbot.yaml`:
     ```yaml
     env:
       LINKEDIN_ACCESS_TOKEN: eyJhbGc...
     ```

4. **Add to matbot.yaml** (if not already listed):
   ```yaml
   plugins:
     - ./packages/social-linkedin
   ```

5. **Restart Eidan** and verify tools are loaded:
   ```
   [social-linkedin] plugin loaded (oauth on :8103)
   ```
   Available tools: `linkedin_post`, `linkedin_get_profile`, `linkedin_list_feed`

## Tools

### `linkedin_post`

Post a message to your LinkedIn feed.

**Parameters:**
- `text` (required, ≤3000 characters): The post text
- `image_url` (optional): Image URL to attach to the post

**Example:**
```
linkedin_post({
  text: "Excited to announce Eidan 0.7.0! 🚀 Better integrations, faster inference, and expanded social media support. #AI #Agents",
  image_url: "https://example.com/release-banner.jpg"
})
```

**Features:**
- Supports text-only or text + image posts
- Enforces 3000-character limit
- Posts to your personal feed (public visibility)

### `linkedin_get_profile`

Get the authenticated user's LinkedIn profile information.

**Parameters:** None

**Example:**
```
linkedin_get_profile({})
```

**Returns:** User ID, first name, last name, headline, and profile picture URL

### `linkedin_list_feed`

List recent posts published **by** your connected LinkedIn account (your own posts, or your organization's Page posts).

**Parameters:**
- `limit` (optional, 1–100): Max posts (default: 20)

**Example:**
```
linkedin_list_feed({ limit: 30 })
```

**Returns:** Recent posts authored by this account with metadata (text, post IDs)

**⚠️ Engagement Limitation:** Likes and comments currently return `0` because LinkedIn's Community Management API requires the restricted `r_member_social_feed` permission (available only on standard tier). The operator has filed for standard tier access. Once approved, engagement data can be fetched from the Reactions API. See the [upgrade path](#upgrade-path-engagement-metrics-once-standard-tier-approved) below.

## How It Works

1. **Auth**: Uses LinkedIn OAuth2 token (Bearer token)
   - Token is stored securely in Eidan vault (encrypted at-rest)
   - No token refresh flow (valid for 2 months by default)
   - Can be rotated by generating a new token in LinkedIn developer settings

2. **Credentials**: All credentials stored in Eidan vault (encrypted)
   - Never logged, never exposed in errors
   - Can be updated via Settings UI at any time

3. **API**: Uses LinkedIn API v2 (REST)
   - Posts via `/ugcPosts`
   - Profile via `/me`
   - Feed via `/posts?q=author`

## Security Considerations

### SSRF Protection

This plugin validates image URLs to prevent Server-Side Request Forgery (SSRF) attacks:
- **Enforces HTTPS**: Only HTTPS URLs are accepted
- **Blocks private/internal IPs**: DNS lookups reject addresses in private ranges (10.0.0.0/8, 192.168.0.0/16, 127.0.0.0/8, etc.)
- **Validates redirects**: Each redirect target is re-validated before following
- **Domain whitelist**: Image URLs must come from trusted CDN/hosting domains (Cloudinary, Unsplash, Imgur, etc.)

**Adding New Domains:**

To allow images from additional domains, edit `packages/social-linkedin/src/client.ts` and add the domain to the `ALLOWED_IMAGE_DOMAINS` list (around line 16):

```typescript
const ALLOWED_IMAGE_DOMAINS = [
  // existing domains...
  'your-custom-cdn.com',    // Add your domain here
];
```

Then redeploy. This approach prevents SSRF by requiring explicit configuration rather than allowing arbitrary domains. For frequent additions, consider:
- Using a shared CDN that's already whitelisted
- Running an internal proxy that re-hosts images from untrusted sources
- Discussing a more flexible configuration approach (environment variables) with your team

**Limitations:**
- DNS rebinding attacks can bypass DNS-based validation if the DNS record is changed after the initial lookup
- For high-security deployments, consider using an image proxy service or a firewall-level domain whitelist instead of relying on DNS validation

### Token Storage

- Access tokens are stored encrypted in the Eidan vault (encrypted at-rest, never logged)
- Token rotation: Generate a new token in LinkedIn developer settings if compromised
- Note: LinkedIn tokens are typically valid for ~2 months; plan for regular rotation

## API Permissions & Limitations

### Current Permission Status

| Feature | Endpoint | Permission Required | Status | Notes |
|---------|----------|-------------------|--------|-------|
| Post to LinkedIn | `/ugcPosts` | `w_member_social` | ✅ Working | Create posts with text and images |
| Get profile | `/userinfo`, `/organizations/{id}` | OpenID Connect (implicit) | ✅ Working | Retrieve authenticated user/org details |
| List own posts | `/posts?q=author` | `r_member_social` | ✅ Working | Read posts authored by this account |
| **Engagement metrics** | **`/reactions?q=post`** | **`r_member_social_feed` (restricted)** | ⏳ Pending | Blocked until standard tier approved |

### Known Limitations

1. **Engagement Data Unavailable**: The `likes` and `comments` fields in `linkedin_list_feed` return `0` because the Reactions API requires the restricted `r_member_social_feed` permission. This permission is only available to select LinkedIn developers and requires filing for standard tier access.

2. **Own Posts Only**: LinkedIn has no public API to read other members' feeds or search across all posts. The `linkedin_list_feed` tool only returns posts authored by your connected account.

3. **No Direct Messages**: LinkedIn API v2 does not support direct messaging (blocked by LinkedIn for consumer use).

### Workaround for Important Posts

If you need engagement metrics for critical posts before standard tier is approved:

1. **Manual Check**: Visit your post directly on LinkedIn.com to see live engagement
2. **Export Metrics**: Screenshot or copy engagement data from the UI
3. **Escalation**: Contact LinkedIn Developer Support to prioritize your standard tier request

## Troubleshooting

### "LinkedIn isn't connected"

Ensure the access token is set:
```bash
# Check vault or Settings UI
LINKEDIN_ACCESS_TOKEN: <not set>
```

Generate a new token at https://www.linkedin.com/developers/apps and update the vault.

### "Request failed: 401 Unauthorized"

Your access token has expired or is invalid. Generate a new one at https://www.linkedin.com/developers/apps and update the vault.

### "Post text is required" or "text is required"

The `text` parameter is mandatory for posting. Provide non-empty text.

### Rate Limiting

LinkedIn enforces rate limits per token. If you hit limits:
- Wait 24 hours before retrying
- Spread posts across time (avoid bulk posting)
- Use lower limits for search/feed queries

## Architecture

- **client.ts**: LinkedIn API v2 client (REST via Bearer token)
- **tools.ts**: Agent tools (post, profile, feed)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: LinkedIn API TypeScript definitions
- **index.ts**: Plugin registration

## Limits

- Posts: 3000 characters max
- Feed: 100 posts max per call
- Access token: valid for ~2 months (LinkedIn default)
- Rate limits: LinkedIn API rate limits per token

## Example Agent Usage

```
Agent: Share a milestone on LinkedIn.

Agent → linkedin_post({
  text: "🎉 Excited to announce that our team just reached 1M users! Thank you to everyone who made this possible. Here's to the next chapter. #Growth #Milestone"
})

Result: {
  id: "7123456789",
  text: "🎉 Excited to announce...",
  message: "Posted to LinkedIn"
}

Agent: Check your profile and list your recent posts.

Agent → linkedin_get_profile({})

Result: {
  id: "XYZ789",
  name: "John Doe",
  kind: "member",
  headline: "AI Engineer at TechCorp",
  picture: "https://media.licdn.com/..."
}

Agent → linkedin_list_feed({ limit: 5 })

Result: {
  count: 5,
  posts: [
    {
      id: "urn:li:share:7222222222",
      text: "New research on LLMs dropped today...",
      likes: 0,
      comments: 0,
      engagement_data_available: false
    },
    ...
  ],
  notice: "Engagement metrics (likes, comments) are currently unavailable. Requires LinkedIn Community Management API standard tier + r_member_social_feed permission."
}
```

## OAuth2 Token Rotation

If your token expires:

1. Visit https://www.linkedin.com/developers/apps
2. Select your app
3. Go to "Auth" tab
4. Generate a new Bearer token
5. Update vault via Settings UI (Connections → LinkedIn Social → LINKEDIN_ACCESS_TOKEN)

## Upgrade Path: Engagement Metrics (Once Standard Tier Approved)

LinkedIn's Community Management API currently does not return engagement metrics (likes, comments) in the `/posts` endpoint due to permission restrictions. The operator has filed for standard tier access with the `r_member_social_feed` permission.

**Current Status:**
- Tier: Development
- Permission: Not yet granted
- Engagement metrics: `likes: 0, comments: 0` (placeholder values)

**Once Standard Tier + r_member_social_feed Permission is Approved:**
1. The `linkedin_list_feed` tool can be enhanced to fetch engagement metrics via the Reactions API
2. Implementation: For each post, call `/reactions?q=post` with the post URN
3. Parse reaction types (LIKE, COMMENT_LIKE, etc.) to populate `likes` and `comments` fields
4. The `engagement_data_available` field on each post will switch to `true`

**References:**
- LinkedIn Reactions API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reactions-api
- Community Management API Permissions: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/authentication
- Post this upgrade path in the PR/issue tracker for visibility when standard tier is approved

## Future Enhancements

- Direct messaging
- Profile metadata (followers, connections, skills)
- Scheduled posts
- Comment creation
- Media upload (images, videos)
- Multi-account support (token per tool call)
- Webhook notifications for engagement
- Analytics (view count, click-through rate)

## API Reference

For more details on LinkedIn API v2, see:
- https://learn.microsoft.com/en-us/linkedin/shared/api-reference/api-reference
- https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2

## Support

For issues with this plugin, check:
1. Token validity at https://www.linkedin.com/developers/apps
2. Eidan logs for API error details
3. LinkedIn API rate limits (429 Too Many Requests)
