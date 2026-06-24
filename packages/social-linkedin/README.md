# @eidandev/social-linkedin

LinkedIn Social integration for Eidan: post to LinkedIn, search posts, get profile information, and read your feed via OAuth2.

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
   [social-linkedin] plugin loaded: linkedin_post, linkedin_search, linkedin_get_profile, linkedin_list_feed
   ```

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

### `linkedin_search`

Search LinkedIn for posts by keyword, topic, or company name.

**Parameters:**
- `query` (required): Search text (keywords, company names, topics)
- `limit` (optional, 1–100): Max results (default: 20)

**Example:**
```
linkedin_search({
  query: "AI agents productivity",
  limit: 10
})
```

**Returns:** Posts with text, author, and engagement metrics (likes, comments)

### `linkedin_get_profile`

Get the authenticated user's LinkedIn profile information.

**Parameters:** None

**Example:**
```
linkedin_get_profile({})
```

**Returns:** User ID, first name, last name, headline, and profile picture URL

### `linkedin_list_feed`

Read your LinkedIn feed.

**Parameters:**
- `limit` (optional, 1–100): Max posts (default: 20)

**Example:**
```
linkedin_list_feed({ limit: 30 })
```

**Returns:** Recent posts from your network with engagement metrics

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
   - Search via `/search/posts`
   - Profile via `/me`
   - Feed via `/feed`

## Security Considerations

### SSRF Protection

This plugin validates image URLs to prevent Server-Side Request Forgery (SSRF) attacks:
- **Enforces HTTPS**: Only HTTPS URLs are accepted
- **Blocks private/internal IPs**: DNS lookups reject addresses in private ranges (10.0.0.0/8, 192.168.0.0/16, 127.0.0.0/8, etc.)
- **Validates redirects**: Each redirect target is re-validated before following
- **Domain whitelist**: Image URLs must come from trusted CDN/hosting domains (Cloudinary, Unsplash, Imgur, etc.)

**Adding New Domains:**

To allow images from additional domains, set the `LINKEDIN_IMAGE_DOMAINS` environment variable with a comma-separated list:

```bash
# In matbot.yaml or .env
LINKEDIN_IMAGE_DOMAINS=your-cdn.com,another-cdn.com
```

This extends the default whitelist (Cloudinary, Unsplash, Imgur, etc.). For more control, alternatively:
- Use a shared CDN that's already whitelisted
- Run an internal proxy that re-hosts images from untrusted sources

**Limitations:**
- DNS rebinding attacks can bypass DNS-based validation if the DNS record is changed after the initial lookup
- For high-security deployments, consider using an image proxy service or a firewall-level domain whitelist instead of relying on DNS validation

### Token Storage

- Access tokens are stored encrypted in the Eidan vault (encrypted at-rest, never logged)
- Token rotation: Generate a new token in LinkedIn developer settings if compromised
- Note: LinkedIn tokens are typically valid for ~2 months; plan for regular rotation

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
- **tools.ts**: Agent tools (post, search, profile, feed)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: LinkedIn API TypeScript definitions
- **index.ts**: Plugin registration

## Limits

- Posts: 3000 characters max
- Search: 100 results max per call
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

Agent: Find recent discussions about AI and productivity.

Agent → linkedin_search({
  query: "AI productivity tools",
  limit: 5
})

Result: {
  query: "AI productivity tools",
  count: 5,
  posts: [
    {
      id: "7111111111",
      text: "Just launched our new AI productivity suite...",
      author: "urn:li:person:ABC123",
      likes: 234,
      comments: 12
    },
    ...
  ]
}

Agent: Check your profile and read your feed.

Agent → linkedin_get_profile({})

Result: {
  id: "XYZ789",
  firstName: "John",
  lastName: "Doe",
  headline: "AI Engineer at TechCorp",
  profilePicture: "https://media.licdn.com/..."
}

Agent → linkedin_list_feed({ limit: 5 })

Result: {
  count: 5,
  posts: [
    {
      id: "7222222222",
      text: "New research on LLMs dropped today...",
      author: "urn:li:person:DEF456",
      likes: 567,
      comments: 89
    },
    ...
  ]
}
```

## OAuth2 Token Rotation

If your token expires:

1. Visit https://www.linkedin.com/developers/apps
2. Select your app
3. Go to "Auth" tab
4. Generate a new Bearer token
5. Update vault via Settings UI (Connections → LinkedIn Social → LINKEDIN_ACCESS_TOKEN)

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
