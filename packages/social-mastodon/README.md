# Mastodon Plugin

Post to Mastodon, search posts, and view profile via Mastodon API.

## Tools

- `mastodon_post(text, spoiler_text?, visibility?)` - Post text to your Mastodon account
- `mastodon_search(query, limit?)` - Search Mastodon posts by keyword or hashtag
- `mastodon_profile()` - Get your Mastodon profile information

## Setup

1. Generate an OAuth token at your Mastodon instance: Preferences > Development > New application
2. Store in vault:
   - `MASTODON_INSTANCE_URL` - Your Mastodon instance URL (e.g., https://mastodon.social)
   - `MASTODON_ACCESS_TOKEN` - Your API access token

## Example

```
Post: "Excited to announce my new project! #opensource"
Search: "climate change"
Profile: Get profile info
```

## Troubleshooting

- **Authentication failed**: Check MASTODON_ACCESS_TOKEN is valid
- **Instance not found**: Verify MASTODON_INSTANCE_URL is correct
- **Rate limiting**: Mastodon API has rate limits; retry after delay
