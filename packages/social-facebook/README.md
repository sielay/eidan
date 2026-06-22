# @eidandev/social-facebook

Facebook Social integration for Eidan: post to Facebook, search posts, read your feed, and get your profile via the Facebook Graph API with OAuth2 token.

## Setup

1. **Generate a Facebook Access Token**:
   - Visit https://developers.facebook.com/tools/explorer
   - Select your app and user token
   - Ensure token has `publish_pages`, `manage_pages`, and `user_photos` permissions for posting and page access
   - Copy the access token

2. **Configure Eidan vault secrets**:
   - Via the Settings UI (Connections → Facebook Social):
     - **FACEBOOK_ACCESS_TOKEN**: The access token from step 1
     - **FACEBOOK_PAGE_ID** (optional): Your Facebook Page ID to post as a page instead of personal feed
   - Or via environment/gitignored `matbot.yaml`:
     ```yaml
     env:
       FACEBOOK_ACCESS_TOKEN: eaabcd...
       FACEBOOK_PAGE_ID: "123456789"  # optional
     ```

3. **Add to matbot.yaml** (if not already listed):
   ```yaml
   plugins:
     - ./packages/social-facebook
   ```

4. **Restart Eidan** and verify tools are loaded:
   ```
   [social-facebook] plugin loaded: facebook_post_feed, facebook_search, facebook_get_profile, facebook_list_feed
   ```

## Tools

### `facebook_post_feed`

Post a message to your Facebook personal feed or page.

**Parameters:**
- `text` (required): The post text
- `image_url` (optional): URL of an image to attach to the post

**Example:**
```
facebook_post_feed({
  text: "Hello Facebook! 🚀 #eidan",
  image_url: "https://example.com/photo.jpg"
})
```

**Features:**
- Post to personal feed (default) or page (if FACEBOOK_PAGE_ID set)
- Attach image URLs
- Supports hashtags and mentions in text

### `facebook_search`

Search Facebook for posts by keyword, hashtag, or user name.

**Parameters:**
- `query` (required): Search text (keywords, #hashtags, user names)
- `limit` (optional, 1–100): Max results (default: 20)

**Example:**
```
facebook_search({
  query: "#eidan agent",
  limit: 10
})
```

**Returns:** Posts with ID, message, type, creation time, and engagement metrics (likes, comments, shares)

### `facebook_get_profile`

Get the authenticated user's Facebook profile info.

**Parameters:** None

**Example:**
```
facebook_get_profile()
```

**Returns:** User ID, name, bio, friend count, and profile picture URL

### `facebook_list_feed`

Read your Facebook feed or page timeline.

**Parameters:**
- `limit` (optional, 1–100): Max posts (default: 20)

**Example:**
```
facebook_list_feed({ limit: 30 })
```

**Returns:** Recent posts with engagement metrics (likes, comments, shares) and links

## How It Works

1. **Auth**: Uses long-lived OAuth2 access tokens (generated via Graph API Explorer or app permissions)
   - Token is stored securely in Eidan vault (encrypted at-rest via Fernet)
   - No automatic refresh; token must be refreshed manually at https://developers.facebook.com when it expires (~60 days)

2. **Credentials**: All credentials stored in Eidan vault (encrypted)
   - Never logged, never exposed in errors
   - Can be rotated by generating a new token and updating vault

3. **API**: Uses Facebook Graph API (v18.0)
   - Posts via `/{user-id}/feed` or `/{page-id}/feed` (POST)
   - Search via `/search` (GET)
   - Feed via `/{user-id}/feed` or `/{page-id}/feed` (GET)
   - Profile via `/me` (GET)

## Troubleshooting

### "Facebook isn't connected"

Ensure the secret is set:
```bash
FACEBOOK_ACCESS_TOKEN: <not set>
```

Set it via Settings UI or environment.

### "Invalid request" or "Unauthorized" errors

- Token may have expired (expires ~60 days after generation)
- Regenerate at https://developers.facebook.com/tools/explorer
- Ensure token has required permissions: `publish_pages`, `manage_pages`

### Posting as a page instead of personal feed

Set `FACEBOOK_PAGE_ID` to your page's ID (find it at https://www.facebook.com/your-page/settings/basic):

```bash
FACEBOOK_PAGE_ID: 123456789
```

Then posts will go to the page feed instead of your personal feed.

### Search returns no results

- Facebook's search API has limitations; not all public posts are searchable
- Try searching by user name (e.g., `@username`) or hashtag (e.g., `#hashtag`)
- Some posts may be limited by privacy settings

### Image attachment fails

- Image URL must be publicly accessible
- Ensure the URL is a direct link to an image (not a webpage)

## Architecture

- **client.ts**: Facebook Graph API client (OAuth2 token handling, feed/search/post operations)
- **tools.ts**: Agent tools (post, search, profile, feed)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: Facebook API TypeScript definitions

## Limits

- Posts: No character limit enforced by plugin (Facebook's server will reject oversized posts)
- Search: 100 results max per call
- Feed: 100 posts max per call
- Access Token: Long-lived, expires after ~60 days (manual refresh required)

## Example Agent Usage

```
Agent: Post an update about the new Eidan release.

Agent → facebook_post_feed({
  text: "🚀 Eidan 0.5.0 is live! New features: Facebook integration, improved memory recall, and faster agent responses. Build with us: https://eidan.dev #eidan #agent"
})

Result: {
  id: "123456789_987654321",
  text: "🚀 Eidan 0.5.0 is live! ...",
  message: "Posted to Facebook"
}

Agent: Search for recent discussions about AI agents on Facebook.

Agent → facebook_search({
  query: "#AI agents",
  limit: 5
})

Result: {
  query: "#AI agents",
  count: 5,
  posts: [
    {
      id: "987654321_123456789",
      message: "Building an AI agent framework with distributed training...",
      type: "status",
      created: "2026-06-21T20:30:00Z",
      likes: 234,
      comments: 12,
      shares: 45
    },
    ...
  ]
}

Agent: Get your Facebook profile info.

Agent → facebook_get_profile()

Result: {
  id: "user123",
  name: "John Doe",
  bio: "AI enthusiast, builder",
  friends_count: 500,
  picture_url: "https://platform-lookaside.fbsbx.com/..."
}

Agent: Read your Facebook feed to find interesting posts.

Agent → facebook_list_feed({ limit: 10 })

Result: {
  count: 10,
  posts: [
    {
      id: "123456789_987654321",
      message: "Just deployed my latest model on the cloud...",
      type: "status",
      created: "2026-06-21T20:30:00Z",
      likes: 89,
      comments: 5,
      shares: 12,
      link: null
    },
    ...
  ]
}
```

## Token Refresh & Expiry

- Facebook access tokens expire after ~60 days
- When expired, all API calls return "Unauthorized" errors
- Generate a new token at https://developers.facebook.com/tools/explorer and update vault secrets
- No automatic refresh; manual intervention required

## Future Enhancements

- Metrics capture (like count trends, engagement analytics)
- Comment/reaction notifications
- Direct messages
- Profile metadata expansion (followers, verified status)
- Media upload (video support beyond images)
- Batch operations (multi-post, multi-search)
- Access token auto-refresh via app-specific refresh flow (if using user-authenticated app)

## Permissions Reference

For full functionality, your access token should have these permissions:

- `publish_pages`: Post to pages
- `manage_pages`: Access page feeds
- `user_photos`: Attach images to posts
- `user_friends`: Read friend count
- `user_events`: (optional) Read events

Generate with all permissions at https://developers.facebook.com/tools/explorer.
