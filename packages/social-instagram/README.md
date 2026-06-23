# @eidandev/social-instagram

Instagram Social plugin for eidan: post to Instagram, search hashtags and users, read your feed, and get profile information via the Instagram Graph API.

## Features

- **Post to Feed** (`instagram_post_feed`): Post images with captions to your Instagram feed
- **Search** (`instagram_search`): Search for hashtags and users on Instagram
- **Get Profile** (`instagram_get_profile`): Fetch your Instagram profile information (followers, bio, verification, etc.)
- **List Feed** (`instagram_list_feed`): Read your recent Instagram posts with engagement metrics

## Setup

### Prerequisites

1. **Facebook Developer Account**: Create one at https://developers.facebook.com/ if you don't have one
2. **Instagram Business Account**: Your Instagram account must be a business/creator account
3. **Facebook App**: Create a new app in the developer console

### Step 1: Create a Facebook App

1. Go to https://developers.facebook.com/apps
2. Click "Create App"
3. Choose "Business" as the app type
4. Fill in app details (name, email, purpose)
5. Complete the setup

### Step 2: Configure Instagram Graph API

1. In your app dashboard, add the "Instagram Graph API" product
2. Go to "Settings → Basic" to get your App ID and App Secret
3. Add a Test User or use your own account
4. Generate an access token with these scopes:
   - `instagram_basic`
   - `instagram_graph_user_media`
   - `instagram_graph_user_profile`

### Step 3: Generate Long-Lived Access Token

1. Start with a short-lived user access token (generated above)
2. Exchange it for a long-lived token using Facebook's Graph API Explorer or via API:

```bash
curl "https://graph.instagram.com/access_token?grant_type=ig_refresh_token&access_token=SHORT_LIVED_TOKEN"
```

This returns a long-lived token valid for ~60 days. You'll need to refresh it periodically.

### Step 4: Add to Vault

1. Open eidan Settings → Connections
2. Navigate to "Instagram Social"
3. Paste your long-lived access token in the "Instagram Graph API Access Token" field
4. Save

Or set via environment:

```bash
export INSTAGRAM_ACCESS_TOKEN=your_long_lived_token
```

## Tools

### instagram_post_feed

Post an image with caption to your Instagram feed.

**Parameters:**
- `text` (string, required): Post caption (max 2200 characters)
- `image_url` (string, required): Public URL to JPEG/PNG image (min 1080x1350 px)

**Example:**
```json
{
  "text": "Beautiful sunset 🌅 #travel #photography",
  "image_url": "https://example.com/sunset.jpg"
}
```

**Returns:**
- `id`: Media ID
- `caption`: Posted caption
- `image_url`: Image URL
- `message`: Confirmation message

### instagram_search

Search for hashtags or users on Instagram.

**Parameters:**
- `query` (string, required): Hashtag name (with or without #), username, or keyword
- `limit` (integer, optional): Max results (1-100, default 20)

**Example:**
```json
{
  "query": "travel",
  "limit": 10
}
```

**Returns:**
- For hashtags: `hashtag`, list of recent `posts` with engagement metrics
- For users: list of matching `users` with usernames
- `count`: Number of results

### instagram_get_profile

Get your authenticated Instagram profile information.

**Parameters:** None

**Returns:**
- `username`: Your Instagram username
- `name`: Display name
- `bio`: Biography
- `followers`: Follower count
- `following`: Following count
- `posts`: Total posts count
- `profile_picture`: Profile picture URL
- `is_professional`: Whether account is professional/creator
- `website`: Website link (if set)

### instagram_list_feed

Get your recent Instagram posts.

**Parameters:**
- `limit` (integer, optional): Max posts (1-100, default 20)

**Example:**
```json
{
  "limit": 10
}
```

**Returns:**
- List of recent `posts` with:
  - `id`: Post ID
  - `caption`: Post caption
  - `media_type`: IMAGE, VIDEO, or CAROUSEL
  - `media_url`: Image/video URL
  - `permalink`: Direct link to post
  - `likes`: Like count
  - `comments`: Comment count
  - `timestamp`: Posted at (ISO 8601)
- `count`: Number of posts returned

## Troubleshooting

### "Instagram isn't connected"
- Verify `INSTAGRAM_ACCESS_TOKEN` is set in vault/env
- Check that the token hasn't expired (long-lived tokens expire after ~60 days)
- Generate a fresh access token if needed

### "Upload failed" or image errors
- Ensure image URL is publicly accessible (not behind auth)
- Check image format (must be JPEG or PNG)
- Verify image dimensions (minimum 1080x1350 pixels)
- Test URL in browser to confirm it works

### "Failed to get authenticated user"
- Token may have insufficient scopes
- Regenerate token with correct scopes: `instagram_basic`, `instagram_graph_user_media`, `instagram_graph_user_profile`
- Ensure your Instagram account is a business/creator account

### Rate limiting
- Instagram Graph API has rate limits
- If you hit rate limits, wait before retrying
- Check https://developers.instagram.com/ for current limits

## Development

### Testing

```bash
pnpm test
```

Tests use mocked API responses and don't require a real access token.

### Type checking

```bash
pnpm typecheck
```

## References

- [Instagram Graph API Docs](https://developers.facebook.com/docs/instagram-graph-api)
- [Generate Access Tokens](https://developers.facebook.com/docs/instagram-basic-display/guides/long-lived-access-tokens)
- [API Reference](https://developers.facebook.com/docs/instagram-api)
