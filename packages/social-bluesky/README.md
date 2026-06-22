# @eidandev/social-bluesky

Bluesky Social integration for Eidan: post to Bluesky, search posts, and read your feed via the AT Protocol with app-password OAuth.

## Setup

1. **Create a Bluesky App Password** (NOT your login password):
   - Visit https://bsky.app/settings/app-passwords
   - Give it a name (e.g., "Eidan Agent")
   - Copy the generated password (16 characters, one time only)

2. **Configure Eidan vault secrets**:
   - Via the Settings UI (Connections → Bluesky Social):
     - **BLUESKY_HANDLE**: Your Bluesky handle (e.g., `user.bsky.social`)
     - **BLUESKY_APP_PASSWORD**: The 16-character app password from step 1
   - Or via environment/gitignored `matbot.yaml`:
     ```yaml
     env:
       BLUESKY_HANDLE: user.bsky.social
       BLUESKY_APP_PASSWORD: xxxx-xxxx-xxxx-xxxx
     ```

3. **Add to matbot.yaml** (if not already listed):
   ```yaml
   plugins:
     - ./packages/social-bluesky
   ```

4. **Restart Eidan** and verify tools are loaded:
   ```
   [social-bluesky] plugin loaded: bluesky_post, bluesky_search, bluesky_read_feed
   ```

## Tools

### `bluesky_post`

Post a message to your Bluesky account.

**Parameters:**
- `text` (required, ≤300 characters): The post text
- `reply_to` (optional): Post URI to reply to (format: `at://...`)

**Example:**
```
bluesky_post({
  text: "Hello Bluesky! 🚀 #eidan",
  reply_to: "at://did:plc:example/app.bsky.feed.post/12345"
})
```

**Features:**
- Auto-detects URLs and converts to links (#facets)
- Auto-detects #hashtags
- Enforces 300-character limit (grapheme count, emoji-aware)
- Supports threaded replies

### `bluesky_search`

Search Bluesky for posts by keyword, hashtag, or @handle.

**Parameters:**
- `query` (required): Search text (keywords, #hashtags, @handles)
- `limit` (optional, 1–100): Max results (default: 20)

**Example:**
```
bluesky_search({
  query: "#bluesky agent",
  limit: 10
})
```

**Returns:** Posts with author info and engagement metrics (likes, replies, reposts)

### `bluesky_read_feed`

Read your Bluesky feed (home timeline).

**Parameters:**
- `limit` (optional, 1–100): Max posts (default: 20)

**Example:**
```
bluesky_read_feed({ limit: 30 })
```

**Returns:** Recent posts from followed accounts with engagement metrics

## How It Works

1. **Auth Flow**: Uses Bluesky's app-password OAuth (no manual token management)
   - On first call: exchanges handle + app password for access/refresh JWTs
   - Caches access JWT in vault with ~2h expiry
   - Auto-refreshes or re-mints before expiry (5-min window)
   - Falls back to fresh session if refresh fails

2. **Credentials**: All credentials stored in Eidan vault (encrypted at-rest via Fernet)
   - Never logged, never exposed in errors
   - Can be rotated by revoking the app password and re-entering at Settings UI

3. **API**: Uses AT Protocol (Bluesky's decentralized protocol)
   - Posts via `com.atproto.repo.createRecord`
   - Search via `app.bsky.feed.searchPosts`
   - Feed via `app.bsky.feed.getAuthorFeed`

## Troubleshooting

### "Bluesky isn't connected"

Ensure both secrets are set:
```bash
# Check via vault query or logs
BLUESKY_HANDLE: <not set>
BLUESKY_APP_PASSWORD: <not set>
```

### "Post exceeds 300 character limit"

Bluesky limits posts to 300 grapheme clusters (emoji count as 1). Shorten the text.

### "Reply parent not found"

The `reply_to` URI must be a valid Bluesky post (format: `at://did:plc:.../app.bsky.feed.post/...`). Check the URI is correct.

### App password no longer works

Bluesky app passwords are one-time only in some contexts. Generate a new one at https://bsky.app/settings/app-passwords and update the vault.

## Architecture

- **client.ts**: AT Protocol client (session management, JWT rotation, facet detection)
- **tools.ts**: Agent tools (post, search, feed)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: Bluesky protocol TypeScript definitions

## Limits

- Posts: 300 characters (grapheme count)
- Search: 100 results max
- Feed: 100 posts max per call
- Access JWT: ~2 hours (auto-refreshed)
- Refresh JWT: long-lived (rotated per refresh)

## Example Agent Usage

```
Agent: Post an update about the new Eidan release.

Agent → bluesky_post({
  text: "🚀 Eidan 0.5.0 is live! New features: Bluesky integration, improved memory recall, and faster agent responses. Build with us: https://eidan.dev #eidan #agent"
})

Result: {
  uri: "at://did:plc:example/app.bsky.feed.post/12345",
  cid: "bafy...",
  text: "🚀 Eidan 0.5.0 is live! ...",
  message: "Posted to Bluesky"
}

Agent: Search for recent discussions about AI agents on Bluesky.

Agent → bluesky_search({
  query: "#AI agents",
  limit: 5
})

Result: {
  query: "#AI agents",
  count: 5,
  posts: [
    {
      uri: "at://did:plc:abc/app.bsky.feed.post/xyz",
      author: "alice.bsky.social (Alice)",
      text: "Building an AI agent framework with distributed training...",
      likes: 234,
      replies: 12,
      reposts: 45
    },
    ...
  ]
}

Agent: Read your Bluesky feed to find interesting posts from your network.

Agent → bluesky_read_feed({ limit: 10 })

Result: {
  count: 10,
  posts: [
    {
      uri: "at://did:plc:xyz/app.bsky.feed.post/123",
      author: "bob.bsky.social (Bob Cooper)",
      text: "Just deployed my latest model on the cloud...",
      likes: 89,
      replies: 5,
      reposts: 12,
      created: "2026-06-21T20:30:00Z"
    },
    ...
  ]
}
```

## JWT Caching & Token Rotation

- **First call**: App password + handle → createSession → get access + refresh JWTs
- **Subsequent calls** (within 2h): Use cached access JWT (no API call)
- **After 2h**: Auto-refresh using refresh JWT (one API call)
- **Refresh fails**: Re-mint from app password (fallback, one API call)
- **App password revoked**: Return auth error; user must re-configure

All JWTs are cached in-memory per-request (not persisted). The app password is the stable credential in vault.

## Future Enhancements

- Metrics capture (like count trends)
- Reply/mention notifications
- Direct messages
- Profile metadata (avatar, bio, follower count)
- Media upload (images, videos)
- Scheduled posts
- Persistence of JWTs in vault (for faster subsequent calls)
- Multi-account support (handle per tool call)
