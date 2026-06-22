# Threads Plugin

Post to Threads, search posts, and view profile via Threads API.

## Tools

- `threads_post(text, media_url?)` - Post a message to Threads
- `threads_search(query, limit?)` - Search Threads for posts by keyword or hashtag
- `threads_profile()` - Get your Threads profile information

## Setup

1. Create a Threads account at https://www.threads.net
2. Go to Settings > Apps to create an OAuth app
3. Generate access token
4. Store in vault:
   - `THREADS_ACCESS_TOKEN` - Your API access token
   - `THREADS_USER_ID` - Your numeric user ID

## Example

```
Post: text="Just launched my new project!"
Search: query="artificial intelligence"
Profile: Get profile stats
```

## Troubleshooting

- **Authentication failed**: Check THREADS_ACCESS_TOKEN is valid
- **Invalid user ID**: Verify THREADS_USER_ID is correct
- **Rate limiting**: Threads API has rate limits; retry after delay
