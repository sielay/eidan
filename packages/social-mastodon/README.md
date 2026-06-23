# @eidandev/social-mastodon

Mastodon Social integration for Eidan: post toots, search posts, get profiles, and read timelines via the Mastodon API with OAuth bearer token authentication.

## Setup

1. **Create a Mastodon App** (or use an existing one):
   - Log in to your Mastodon instance
   - Navigate to Settings → Development → New Application
   - Name: "Eidan Agent" (or your preference)
   - Scopes: Select at minimum `read:accounts`, `read:search`, `read:statuses`, `write:statuses`
   - Submit

2. **Generate an Access Token**:
   - In the app details, find the "Access tokens" section
   - Click "Generate new token" or use the default token shown
   - Copy the access token (long string)

3. **Configure Eidan vault secrets**:
   - Via the Settings UI (Connections → Mastodon Social):
     - **MASTODON_INSTANCE**: Your Mastodon instance domain (e.g., `mastodon.social`, `fosstodon.org`, or your custom domain)
     - **MASTODON_ACCESS_TOKEN**: The OAuth access token from step 2
   - Or via environment/gitignored `matbot.yaml`:
     ```yaml
     env:
       MASTODON_INSTANCE: mastodon.social
       MASTODON_ACCESS_TOKEN: your-token-here
     ```

4. **Add to matbot.yaml** (if not already listed):
   ```yaml
   plugins:
     - ./packages/social-mastodon
   ```

5. **Restart Eidan** and verify tools are loaded:
   ```
   [social-mastodon] plugin loaded: mastodon_post, mastodon_search, mastodon_get_profile, mastodon_list_timeline
   ```

## Tools

### `mastodon_post`

Post a toot to your Mastodon account.

**Parameters:**
- `text` (required, ≤500 characters): The toot text
- `reply_to` (optional): Status ID to reply to
- `visibility` (optional): `public` (default), `unlisted`, `private`, or `direct`

**Example:**
```
mastodon_post({
  text: "Hello Mastodon! 🚀 #eidan",
  visibility: "public"
})
```

**Features:**
- Supports public, unlisted, private, and direct visibility
- Can reply to existing toots
- 500-character limit

### `mastodon_search`

Search Mastodon for toots by keyword, hashtag, or @handle.

**Parameters:**
- `query` (required): Search text (keywords, #hashtags, @handles)
- `limit` (optional, 1–40): Max results (default: 20)

**Example:**
```
mastodon_search({
  query: "#mastodon agent",
  limit: 10
})
```

**Returns:** Toots with author info and engagement metrics (favorites, replies, reblogs)

### `mastodon_get_profile`

Get account profile info (followers, bio, avatar, toot count).

**Parameters:**
- `account_id` (optional): Account ID to fetch (default: your own account)

**Example:**
```
mastodon_get_profile({
  account_id: "some-account-id"
})
```

**Returns:** Account information including follower count, bio, creation date, and status count.

### `mastodon_list_timeline`

Read a Mastodon timeline (home feed, local/instance, or federated).

**Parameters:**
- `limit` (optional, 1–40): Max toots (default: 20)
- `timeline_type` (optional): `home` (default, your feed), `local` (instance only), or `federated` (all instances)

**Example:**
```
mastodon_list_timeline({
  timeline_type: "home",
  limit: 10
})
```

**Returns:** Recent toots with author info and engagement metrics

## How It Works

1. **Auth Flow**: Uses OAuth2 bearer token (static, no refresh needed)
   - Token is stored in Eidan vault (encrypted at-rest via Fernet)
   - Used directly in `Authorization: Bearer <token>` header

2. **Credentials**: All credentials stored in Eidan vault
   - Never logged, never exposed in errors
   - Can be rotated by generating a new token and updating the vault

3. **API**: Uses Mastodon's REST API
   - Posts via `POST /api/v1/statuses`
   - Search via `GET /api/v2/search`
   - Profiles via `GET /api/v1/accounts/{id}`
   - Timeline via `GET /api/v1/timelines/{home|public}`

## Troubleshooting

### "Mastodon isn't connected"

Ensure both secrets are set:
```bash
# Check vault or logs
MASTODON_INSTANCE: <not set>
MASTODON_ACCESS_TOKEN: <not set>
```

### "Search failed" or "Failed to post"

- Check that your access token is valid (hasn't been revoked)
- Verify the instance domain is correct
- Confirm your app has the required scopes (`read:statuses`, `write:statuses`, etc.)

### Token no longer works

Generate a new access token via Settings → Development → Applications, then update the vault.

### Instance domain format

Use just the domain without `https://`:
- ✅ Correct: `mastodon.social`, `fosstodon.org`
- ❌ Incorrect: `https://mastodon.social/`, `https://mastodon.social`

## Architecture

- **client.ts**: Mastodon API client (HTTP requests, authentication, error handling)
- **tools.ts**: Agent tools (post, search, profile, timeline)
- **vault.ts**: Secret resolution from matbot vault + environment
- **types.ts**: Mastodon protocol TypeScript definitions

## Limits

- Posts: 500 characters
- Search: 40 results max
- Timeline: 40 toots max per call
- No rate limiting in this client (Mastodon servers implement rate limits)

## Example Agent Usage

```
Agent: Post a toot about the new Eidan release.

Agent → mastodon_post({
  text: "🚀 Eidan 0.5.0 is live! New features: Mastodon integration, improved memory recall, and faster agent responses. Build with us: https://eidan.dev #eidan #agent"
})

Result: {
  id: "123456789",
  url: "https://mastodon.social/@youruser/123456789",
  text: "🚀 Eidan 0.5.0 is live! ...",
  visibility: "public",
  message: "Posted to Mastodon"
}

Agent: Search for recent discussions about AI agents on Mastodon.

Agent → mastodon_search({
  query: "#AI agents",
  limit: 5
})

Result: {
  query: "#AI agents",
  count: 5,
  toots: [
    {
      id: "987654321",
      author: "alice@fosstodon.org (Alice)",
      text: "Building an AI agent framework with distributed training...",
      favorites: 234,
      replies: 12,
      reblogs: 45,
      created: "2026-01-15T10:30:00Z",
      url: "https://fosstodon.org/@alice/987654321"
    },
    ...
  ]
}

Agent: Read your Mastodon feed to find interesting posts.

Agent → mastodon_list_timeline({
  timeline_type: "home",
  limit: 10
})

Result: {
  timeline_type: "home",
  count: 10,
  toots: [
    {
      id: "456789123",
      author: "bob@mastodon.social (Bob Cooper)",
      text: "Just deployed my latest model on the cloud...",
      favorites: 89,
      replies: 5,
      reblogs: 12,
      created: "2026-01-15T15:45:00Z",
      url: "https://mastodon.social/@bob/456789123"
    },
    ...
  ]
}

Agent: Fetch a user's profile information.

Agent → mastodon_get_profile({
  account_id: "109312844649783843"
})

Result: {
  username: "alice@fosstodon.org",
  display_name: "Alice Researcher",
  bio: "AI researcher interested in agent systems",
  followers: 1250,
  following: 456,
  statuses: 2034,
  avatar: "https://fosstodon.org/avatars/...",
  url: "https://fosstodon.org/@alice",
  created: "2022-06-01T12:00:00Z"
}
```

## Limits & Notes

- **Instance diversity**: This plugin works with any Mastodon-compatible instance (Mastodon, Glitch Social, etc.)
- **Token scopes**: Ensure your token has at least `read:accounts`, `read:search`, `read:statuses`, `write:statuses`
- **Visibility**: Default is `public` (everyone can see). Use `unlisted` for your followers only, `private` for followers, `direct` for specific mentions
- **HTML content**: Status content is returned as HTML; the tools strip HTML tags for readability

## Future Enhancements

- Media upload (images, videos)
- Boost/favorite toots
- Follow/unfollow accounts
- Notification streams
- Direct messages
- Scheduled posts
- Multiple account support
