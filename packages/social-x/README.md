# X (Twitter) Plugin

Post tweets, search posts, and view profile via X API v2.

## Tools

- `x_post(text)` - Post a tweet to your X account
- `x_search(query, limit?)` - Search X for recent tweets by keyword
- `x_profile()` - Get your X profile information

## Setup

1. Create a developer account at https://developer.twitter.com
2. Create an OAuth app with read/write permissions
3. Generate access token
4. Store in vault:
   - `X_ACCESS_TOKEN` - Your API bearer token

## Example

```
Post: "Just shipped a new feature! 🚀"
Search: "artificial intelligence"
Profile: Get profile stats
```

## Troubleshooting

- **Authentication failed**: Check X_ACCESS_TOKEN is valid and not expired
- **Rate limited**: X API has rate limits; retry after delay
- **Post failed**: Check text is 280 characters or less
