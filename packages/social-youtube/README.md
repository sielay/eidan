# YouTube Plugin

Search YouTube, upload video metadata, and view channel info via YouTube API.

## Tools

- `youtube_search(query, limit?)` - Search YouTube videos by keyword
- `youtube_upload(title, description?)` - Create a YouTube video metadata entry
- `youtube_channel()` - Get your YouTube channel information

## Setup

1. Create a project at Google Cloud Console and enable YouTube API v3
2. Generate credentials (OAuth for upload/channel, API key for search)
3. Store in vault:
   - `YOUTUBE_API_KEY` - Public API key for search
   - `YOUTUBE_ACCESS_TOKEN` - OAuth access token for upload/channel

## Example

```
Search: "machine learning"
Upload: title="My New Video", description="Check it out"
Channel: Get channel stats
```

## Troubleshooting

- **API key invalid**: Verify YOUTUBE_API_KEY in Google Cloud Console
- **Authentication failed**: Regenerate YOUTUBE_ACCESS_TOKEN
- **Upload limited**: Video metadata only; actual upload requires video file
