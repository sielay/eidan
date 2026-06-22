# @eidandev/social-threads

Threads Social integration for Eidan: post to Threads, search posts, get profile info, and read your timeline via the Meta Threads API with OAuth2 bearer token.

## Setup

1. **Get a Threads API Access Token**:
   - Go to https://developers.facebook.com/
   - Create or select a Meta App
   - Set up a Threads extension
   - Generate an access token with `threads_basic_access` and `threads_content_publish` permissions
   - Copy the access token

2. **Configure Eidan vault secrets**:
   - Via the Settings UI (Connections → Threads Social):
     - **THREADS_ACCESS_TOKEN**: The access token from step 1
   - Or via environment/gitignored `matbot.yaml`:
     ```yaml
     env:
       THREADS_ACCESS_TOKEN: eAAj...
     ```

3. **Add to matbot.yaml** (if not already listed):
   ```yaml
   plugins:
     - ./packages/social-threads
   ```

4. **Restart Eidan** and verify tools are loaded:
   ```
   [social-threads] plugin loaded: threads_post_thread, threads_search, threads_get_profile, threads_list_timeline
   ```

## Tools

### `threads_post_thread`

Post a message to your Threads account.

**Parameters:**
- `text` (required, ≤500 characters): The post text
- `reply_to` (optional): Thread ID to reply to

**Example:**
```
threads_post_thread({
  text: "Hello Threads! 🚀 #eidan",
  reply_to: "thread-123456"
})
```

**Features:**
- Supports up to 500 characters
- Optional threading/replies
- Yields structured error or result

### `threads_search`

Search Threads for posts by keyword or hashtag.

**Parameters:**
- `query` (required): Search text (keywords, hashtags)
- `limit` (optional, 1–100): Max results (default: 20)

**Example:**
```
threads_search({
  query: "#eidan",
  limit: 10
})
```

**Returns:** Matching posts with author info and engagement metrics

### `threads_get_profile`

Get your Threads profile information.

**Parameters:**
None

**Example:**
```
threads_get_profile({})
```

**Returns:** Profile info including follower count, bio, verification status

### `threads_list_timeline`

Read your Threads timeline (your recent posts).

**Parameters:**
- `limit` (optional, 1–100): Max posts (default: 20)

**Example:**
```
threads_list_timeline({ limit: 30 })
```

**Returns:** Your recent posts with engagement metrics (likes, replies, reposts)

## How It Works

1. **Auth Flow**: Uses Meta's OAuth2 bearer token (direct token, not password-based)
   - Token stored in Eidan vault (encrypted at-rest via Fernet)
   - No session management needed
   - Simpler than password-based flows (Bluesky)

2. **Credentials**: All stored in Eidan vault (encrypted at-rest via Fernet)
   - Never logged, never exposed in errors
   - Can be rotated by refreshing the token and re-entering at Settings UI

3. **API**: Uses Meta's Threads API (graph.threads.com)
   - Posts via `POST /me/threads`
   - Search via `GET /ig_hashtag_search`
   - Profile via `GET /me`
   - Timeline via `GET /me/threads`

## Troubleshooting

### "Threads isn't connected"

Ensure the secret is set:
```bash
# Check via vault query or logs
THREADS_ACCESS_TOKEN: <not set>
```

### "Post exceeds 500 character limit"

Threads limits posts to 500 characters. Shorten your text.

### "Search query is required"

Provide a non-empty search query (keyword or hashtag).

### Access token no longer works

Generate a new access token from https://developers.facebook.com/ and update the vault.

## Architecture

- **client.ts**: Threads API client (OAuth2 bearer token, API methods)
- **tools.ts**: Agent tools (post, search, profile, timeline)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: Threads API TypeScript definitions

## Limits

- Posts: 500 characters max
- Search: 100 results max per call
- Timeline: 100 posts max per call
- Rate limits: Per Meta Threads API quotas

## Example Agent Usage

```
Agent: Post an update to Threads about the new Eidan release.

Agent → threads_post_thread({
  text: "🚀 Eidan 0.5.0 is live! New features: Threads integration, improved memory recall, and faster agent responses. Build with us: https://eidan.dev #eidan #agent"
})

Result: {
  id: "thread-123456",
  text: "🚀 Eidan 0.5.0 is live! ...",
  message: "Posted to Threads"
}

Agent: Search for recent discussions about AI agents on Threads.

Agent → threads_search({
  query: "#AI agents",
  limit: 5
})

Result: {
  query: "#AI agents",
  count: 5,
  posts: [
    {
      id: "post-123",
      text: "Building an AI agent framework...",
      author: "alice",
      timestamp: "2026-06-22T10:30:00Z",
      likes: 234,
      replies: 12,
      reposts: 45,
      permalink: "https://threads.net/t/123"
    },
    ...
  ]
}

Agent: Get your Threads profile to see your follower count.

Agent → threads_get_profile({})

Result: {
  id: "user-123",
  username: "myusername",
  name: "My Name",
  biography: "Building AI agents",
  followers: 5000,
  following: 250,
  verified: true,
  website: "https://example.com",
  profile_picture_url: "https://..."
}

Agent: Read your recent Threads to see what resonated with your audience.

Agent → threads_list_timeline({ limit: 10 })

Result: {
  count: 10,
  posts: [
    {
      id: "post-456",
      text: "Just deployed my latest model on the cloud...",
      timestamp: "2026-06-21T20:30:00Z",
      permalink: "https://threads.net/t/456",
      likes: 89,
      replies: 5,
      reposts: 12
    },
    ...
  ]
}
```

## Future Enhancements

- Media upload (images, videos)
- Reply/mention notifications
- Direct messages
- Scheduled posts
- Thread insights/analytics
- Multi-account support
