# LinkedIn Plugin

Post to LinkedIn, search posts, and view profile via LinkedIn API.

## Tools

- `linkedin_post(text)` - Post text to your LinkedIn profile
- `linkedin_search(query, limit?)` - Search LinkedIn posts by keyword
- `linkedin_profile()` - Get your LinkedIn profile information

## Setup

1. Generate an OAuth access token at https://www.linkedin.com/developers
2. Store in vault:
   - `LINKEDIN_ACCESS_TOKEN` - Your API access token
   - `LINKEDIN_USER_ID` - Your numeric LinkedIn user ID

## Example

```
Post: "Just launched an exciting new project! #tech #startup"
Search: "artificial intelligence"
Profile: Get user info
```

## Troubleshooting

- **Authentication failed**: Check LINKEDIN_ACCESS_TOKEN is valid and not expired
- **Invalid user ID**: Verify LINKEDIN_USER_ID matches your account
- **Rate limiting**: LinkedIn API has rate limits; retry after delay
