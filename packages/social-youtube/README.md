# @eidandev/social-youtube

YouTube Social integration for Eidan: post comments, search videos, get channel info, and list your uploads via the YouTube Data API v3 with OAuth2.

## Setup

1. **Create a Google Cloud Project and OAuth2 credentials**:
   - Visit https://console.cloud.google.com/
   - Create a new project (or select an existing one)
   - Enable the YouTube Data API v3 (APIs & Services → Library → search "YouTube Data API v3" → Enable)
   - Create OAuth 2.0 credentials (APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID)
   - Choose application type: "Desktop app"
   - Download the credentials JSON file

2. **Get an OAuth2 access token**:
   - Use Google's OAuth2 playground: https://developers.google.com/oauthplayground
   - Or implement a local OAuth2 flow (see Resources section)
   - Copy the access token (the `access_token` field)

3. **Configure Eidan vault secrets**:
   - Via the Settings UI (Connections → YouTube Social):
     - **YOUTUBE_ACCESS_TOKEN**: The OAuth2 access token from step 2
   - Or via environment/gitignored `matbot.yaml`:
     ```yaml
     env:
       YOUTUBE_ACCESS_TOKEN: ya29.a0AfH6...
     ```

4. **Add to matbot.yaml** (if not already listed):
   ```yaml
   plugins:
     - ./packages/social-youtube
   ```

5. **Restart Eidan** and verify tools are loaded:
   ```
   [social-youtube] plugin loaded: youtube_post_comment, youtube_search, youtube_get_channel, youtube_list_videos
   ```

## Tools

### `youtube_post_comment`

Post a comment on a YouTube video.

**Parameters:**
- `video_id` (required): YouTube video ID (11 characters, found in `youtube.com/watch?v=VIDEO_ID`)
- `text` (required, ≤10,000 characters): The comment text

**Example:**
```
youtube_post_comment({
  video_id: "dQw4w9WgXcQ",
  text: "Great content! Thanks for sharing. #eidan"
})
```

**Returns:** Comment ID and confirmation message

### `youtube_search`

Search YouTube for videos by keywords, channel name, or video title.

**Parameters:**
- `query` (required): Search text (keywords, channel names, video titles)
- `limit` (optional, 1–50): Max results (default: 20)

**Example:**
```
youtube_search({
  query: "AI agents tutorial",
  limit: 10
})
```

**Returns:** List of matching videos with metadata (title, description, channel, publish date, video ID)

### `youtube_get_channel`

Get the authenticated user's YouTube channel information.

**Parameters:** None

**Example:**
```
youtube_get_channel()
```

**Returns:** Channel metadata (name, description, subscriber count, view count, video count, channel ID)

### `youtube_list_videos`

List the authenticated user's uploaded videos.

**Parameters:**
- `limit` (optional, 1–50): Max videos (default: 20)

**Example:**
```
youtube_list_videos({ limit: 10 })
```

**Returns:** List of your videos with metadata (title, description, publish date, video ID)

## How It Works

1. **Auth Flow**: Uses YouTube Data API v3 with OAuth2 bearer token
   - Access token is provided directly (not an interactive flow)
   - Token is stored in Eidan vault (encrypted at-rest via Fernet)
   - Token must be manually refreshed when it expires (see Troubleshooting)

2. **Credentials**: All credentials stored in Eidan vault (encrypted at-rest)
   - Never logged, never exposed in errors
   - Can be rotated by generating a new OAuth2 token and re-entering at Settings UI

3. **API**: Uses YouTube Data API v3 (REST)
   - Comments via `commentThreads.insert`
   - Search via `search.list`
   - Channel info via `channels.list`
   - Videos via `search.list` with `forMine=true`

## Troubleshooting

### "YouTube not connected"

Ensure the access token is set:
```bash
# Check via vault query or logs
YOUTUBE_ACCESS_TOKEN: <not set>
```

Set it via the Settings UI or environment variable.

### "YouTube API error: 401"

The access token has expired or is invalid.
- Generate a new access token via https://developers.google.com/oauthplayground
- Update the vault secret with the new token

### "YouTube API error: 403"

The OAuth2 app lacks required scopes or is not authorized.
- Ensure the app has access to:
  - `https://www.googleapis.com/auth/youtube`
  - `https://www.googleapis.com/auth/youtube.readonly`
- Re-authorize the app if scopes changed

### "No channel found"

The authenticated user doesn't have a YouTube channel.
- Create one at https://www.youtube.com/
- Try again after account setup

### Comment posting fails with "Access Denied"

The video owner may have disabled comments, or the video is private/restricted.
- Check the video's comment settings on YouTube
- Try posting on a different video you have permission to comment on

## Architecture

- **client.ts**: YouTube Data API v3 client (OAuth2 bearer token, API calls)
- **tools.ts**: Agent tools (post comment, search, get channel, list videos)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: YouTube API TypeScript definitions

## Limits

- Comments: 10,000 characters per comment
- Search: 50 results max per call
- Videos: 50 videos max per call
- API quota: Depends on YouTube Data API v3 quotas (default 10,000 units/day)
- Rate limit: API rate-limited per quota unit (typically 1-3 requests/second)

## Resources

### OAuth2 Token Generation

1. **Via Google OAuth2 Playground** (simplest for testing):
   - Visit https://developers.google.com/oauthplayground
   - Select YouTube Data API v3 scopes (left sidebar)
   - Authorize → Exchange auth code for token → Copy access token

2. **Via Google's OAuth2 Quickstart** (for production):
   - https://developers.google.com/youtube/v3/quickstart/nodejs
   - Follow the guide to generate credentials and get an access token

3. **Token Refresh**:
   - Access tokens expire (~1 hour)
   - Use the refresh token to get a new access token
   - Store the refresh token in vault for long-lived automation

### API Documentation

- https://developers.google.com/youtube/v3/docs
- https://developers.google.com/youtube/v3/docs/commentThreads/insert
- https://developers.google.com/youtube/v3/docs/search/list
- https://developers.google.com/youtube/v3/docs/channels/list

## Example Agent Usage

```
Agent: Post a comment on a tutorial video about AI agents.

Agent → youtube_search({
  query: "AI agents tutorial",
  limit: 1
})

Result: {
  query: "AI agents tutorial",
  count: 1,
  videos: [
    {
      videoId: "abc123xyz",
      title: "Building AI Agents: A Beginner's Guide",
      description: "Learn how to build and deploy AI agents...",
      channel: "Tech Academy",
      publishedAt: "2024-01-15T10:30:00Z"
    }
  ]
}

Agent → youtube_post_comment({
  video_id: "abc123xyz",
  text: "Excellent tutorial! I especially liked the section on agent architecture. This helped me understand how to build my own Eidan agent. Thanks for breaking it down step by step. 🚀"
})

Result: {
  commentId: "Ugy4k9_comment_id_xyz",
  videoId: "abc123xyz",
  text: "Excellent tutorial! ...",
  message: "Posted comment to YouTube"
}
```

```
Agent: Get my YouTube channel stats.

Agent → youtube_get_channel()

Result: {
  channelId: "UCmyChannel123",
  title: "My Tech Channel",
  description: "Sharing tutorials and insights on AI, agents, and automation",
  subscribers: "5000",
  views: "250000",
  videos: "45"
}
```

```
Agent: List my recent uploads.

Agent → youtube_list_videos({ limit: 5 })

Result: {
  count: 5,
  videos: [
    {
      videoId: "upload1",
      title: "Building AI Agents with Eidan",
      description: "A deep dive into...",
      publishedAt: "2024-06-20T14:00:00Z"
    },
    {
      videoId: "upload2",
      title: "Automating Your Workflow",
      description: "Learn how to...",
      publishedAt: "2024-06-15T10:30:00Z"
    },
    ...
  ]
}
```

## Security Considerations

- **Access Tokens**: Never share or commit access tokens to version control. Use vault or environment variables.
- **Refresh Tokens**: If using long-lived refresh tokens, store them securely in vault only.
- **Quota**: Monitor your YouTube Data API v3 quota usage (default 10,000 units/day). Comments cost ~1 unit each.
- **Rate Limiting**: Implement backoff for API calls if you hit rate limits.

## Future Enhancements

- Like/dislike videos
- Subscribe to channels
- Get video statistics (views, likes, comments)
- Reply to existing comments (comment threads)
- Delete comments
- Update comments
- Get trending videos
- Get playlists
- Upload videos
- OAuth2 refresh token support (automatic token refresh)
- Batch operations (comment on multiple videos)
