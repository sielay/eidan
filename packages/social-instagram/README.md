# Instagram Plugin

Post to Instagram, search hashtags, and view profile via Instagram Graph API.

## Tools

- `instagram_post(caption, image_url?)` - Post content to your Instagram account
- `instagram_search(hashtag, limit?)` - Search Instagram for hashtags
- `instagram_profile()` - Get your Instagram profile information

## Setup

1. Create a business account at Instagram
2. Connect to Facebook Developer Dashboard
3. Create an OAuth app and get access token
4. Store in vault:
   - `INSTAGRAM_ACCESS_TOKEN` - Your API access token
   - `INSTAGRAM_BUSINESS_ACCOUNT_ID` - Your business account ID

## Example

```
Post: caption="Beautiful sunset 🌅", image_url="https://example.com/image.jpg"
Search: hashtag="photography"
Profile: Get account stats
```

## Troubleshooting

- **Authentication failed**: Check INSTAGRAM_ACCESS_TOKEN is valid
- **Invalid account ID**: Verify INSTAGRAM_BUSINESS_ACCOUNT_ID
- **Image upload failed**: Verify image URL is publicly accessible
