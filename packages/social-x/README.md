# @eidandev/social-x

X (Twitter) Social integration for Eidan: post tweets, search, read your profile, and list your timeline via X API v2 with OAuth2 bearer token authentication.

## Setup

1. **Create or find your X API v2 bearer token**:
   - Visit https://developer.twitter.com/en/portal/dashboard
   - Create an app or use an existing one with read+write permissions
   - Generate or retrieve your OAuth2 bearer token
   - Ensure the app has "Read and Write" permissions under "App Permissions"

2. **Configure Eidan vault secrets**:
   - Via the Settings UI (Connections → X (Twitter) Social):
     - **X_ACCESS_TOKEN**: Your X API v2 OAuth2 bearer token
   - Or via environment/gitignored `matbot.yaml`:
     ```yaml
     env:
       X_ACCESS_TOKEN: your-bearer-token-here
     ```

3. **Add to matbot.yaml** (if not already listed):
   ```yaml
   plugins:
     - ./packages/social-x
   ```

4. **Restart Eidan** and verify tools are loaded:
   ```
   [social-x] plugin loaded: x_post_tweet, x_search, x_get_profile, x_list_timeline
   ```

## Tools

### `x_post_tweet`

Post a tweet to your X account.

**Parameters:**
- `text` (required, ≤280 characters): The tweet text
- `reply_to` (optional): Tweet ID to reply to

**Example:**
```
x_post_tweet({
  text: "Hello X! 🚀 #eidan",
  reply_to: "1234567890"
})
```

**Returns:**
- `tweet_id`: The ID of the posted tweet
- `url`: Direct link to the tweet on Twitter
- `text`: The posted text
- `message`: Confirmation message

### `x_search`

Search X for tweets by keyword, hashtag, or @handle.

**Parameters:**
- `query` (required): Search text (keywords, #hashtags, from:@handle, etc.)
- `limit` (optional, 1–100): Max results (default: 20)

**Example:**
```
x_search({
  query: "#eidan agent",
  limit: 10
})
```

**Returns:** Posts with author ID and engagement metrics (likes, replies, retweets)

### `x_get_profile`

Get your X profile information (followers, bio, verification status).

**Parameters:** None

**Example:**
```
x_get_profile()
```

**Returns:**
- `id`: User ID
- `name`: Display name
- `username`: X handle
- `description`: Bio
- `followers`: Follower count
- `following`: Following count
- `tweets`: Tweet count
- `verified`: Verification status
- `url`: Direct link to profile

### `x_list_timeline`

Get your X timeline (your own recent tweets).

**Parameters:**
- `limit` (optional, 1–100): Max tweets (default: 20)

**Example:**
```
x_list_timeline({ limit: 30 })
```

**Returns:** Your recent tweets with engagement metrics (likes, replies, retweets)

## How It Works

1. **Auth**: Uses X API v2 OAuth2 bearer token authentication
   - Simple token-based auth (no complex JWT rotation needed)
   - Token stored in Eidan vault (encrypted at-rest via Fernet)

2. **API**: Uses X API v2 (not the legacy v1.1)
   - Posts via `/2/tweets`
   - Search via `/2/tweets/search/recent`
   - Profile via `/2/users/me`
   - Timeline via `/2/users/:id/tweets`

3. **Character Limit**: X enforces 280 characters per tweet
   - Posts exceeding this limit are rejected with a clear error

## Troubleshooting

### "X isn't connected"

Ensure the secret is set:
```bash
X_ACCESS_TOKEN: <not set>
```

Set it via Settings UI or environment variable.

### "Tweet exceeds 280 character limit"

X limits tweets to 280 characters (including spaces and emojis). Shorten the text.

### API returns 401 Unauthorized

Your bearer token is invalid or expired:
- Verify the token at https://developer.twitter.com/en/portal/dashboard
- Generate a new token if needed
- Update the vault secret

### API returns 429 Too Many Requests

You've hit X API rate limits. Wait before retrying.
- Search: 300 requests per 15 minutes
- Post: 300 requests per 15 minutes
- Get profile: 300 requests per 15 minutes

## Architecture

- **client.ts**: X API v2 client (HTTP calls, error handling)
- **tools.ts**: Agent tools (post, search, profile, timeline)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: X API v2 TypeScript definitions
- **index.ts**: Plugin registration + secret declarations

## Limits

- Posts: 280 characters per tweet
- Search: 100 results max per call, limited to recent tweets (7 days)
- Timeline: 100 tweets max per call
- Rate limits: X API v2 rate limits apply (varies by endpoint)

## Example Agent Usage

```
Agent: Post an update about the new Eidan release.

Agent → x_post_tweet({
  text: "🚀 Eidan 0.5.0 is live! New features: X integration, improved memory, and faster responses. Build with us: https://eidan.dev #eidan"
})

Result: {
  tweet_id: "1234567890",
  url: "https://twitter.com/i/web/status/1234567890",
  text: "🚀 Eidan 0.5.0 is live! ...",
  message: "Posted to X"
}

Agent: Search for recent discussions about AI agents on X.

Agent → x_search({
  query: "#AI agents",
  limit: 5
})

Result: {
  query: "#AI agents",
  count: 5,
  tweets: [
    {
      id: "1234567890",
      text: "Building an AI agent framework...",
      author_id: "98765",
      created_at: "2024-06-22T10:30:00Z",
      likes: 234,
      replies: 12,
      retweets: 45,
      url: "https://twitter.com/i/web/status/1234567890"
    },
    ...
  ]
}

Agent: Get your X profile information.

Agent → x_get_profile()

Result: {
  id: "98765",
  name: "Eidan Bot",
  username: "eidandev",
  description: "AI agent for your personal OS",
  followers: 1500,
  following: 450,
  tweets: 250,
  verified: false,
  url: "https://twitter.com/eidandev"
}

Agent: Read your recent tweets.

Agent → x_list_timeline({ limit: 10 })

Result: {
  count: 10,
  tweets: [
    {
      id: "1234567890",
      text: "Just deployed Eidan 0.5.0...",
      created_at: "2024-06-22T14:20:00Z",
      likes: 89,
      replies: 5,
      retweets: 12,
      url: "https://twitter.com/i/web/status/1234567890"
    },
    ...
  ]
}
```

## Future Enhancements

- Direct messages
- Retweets and likes
- Media upload (images, videos)
- Scheduled tweets
- Thread creation
- Mentions and replies notifications
- Multi-account support
