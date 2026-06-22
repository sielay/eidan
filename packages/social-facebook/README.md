# Facebook Plugin

Post to Facebook, search posts, and view profile via Facebook Graph API.

## Tools

- `facebook_post(message)` - Post a message to your Facebook feed
- `facebook_search(query, limit?)` - Search Facebook for posts by keyword
- `facebook_profile()` - Get your Facebook profile information

## Setup

1. Create a developer account at https://developers.facebook.com
2. Create an OAuth app
3. Generate an access token
4. Store in vault:
   - `FACEBOOK_ACCESS_TOKEN` - Your API access token
   - `FACEBOOK_USER_ID` - Your numeric Facebook user ID

## Example

```
Post: "Excited about my new project!"
Search: "technology"
Profile: Get profile info
```

## Troubleshooting

- **Authentication failed**: Check FACEBOOK_ACCESS_TOKEN is valid
- **Invalid user ID**: Verify FACEBOOK_USER_ID is correct
- **Rate limiting**: Facebook API has rate limits; retry after delay
