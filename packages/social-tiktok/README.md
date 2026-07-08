# @eidandev/social-tiktok

TikTok Social plugin for eidan: read your profile + videos and publish a video, via the TikTok
**Display API** (read) and **Content Posting API** (publish) with **Login Kit** OAuth2 and matbot
vault secrets.

## Tools

- **Get Profile** (`tiktok_get_profile`): display name, verification, follower / following / likes /
  video counts.
- **List Videos** (`tiktok_list_videos`): your recent videos with engagement metrics (views, likes,
  comments, shares).
- **Post Video** (`tiktok_post_video`): publish a video by pulling it from a **public URL**
  (PULL_FROM_URL). Returns a `publish_id`; TikTok processes upload + moderation asynchronously.

There is **no search** and **no comment/DM** tool — TikTok's public API doesn't expose content search
or comment/DM read/reply (those need the gated Business/Marketing API).

## Setup

1. Create an app at <https://developers.tiktok.com>.
2. Add the **Login Kit**, **Display API**, and (for posting) **Content Posting API** products.
3. **Scopes:** `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`,
   `video.publish`.
4. Register the redirect URI shown on the Connections screen under the app's Login Kit settings.
5. Connect the account under **Settings → Connections → TikTok**, pasting the app's **client key**
   (not id) and **client secret**. Both, plus the access/refresh tokens, are sealed per-account in
   your vault.

## Notes

- Access tokens are short (~24h); the refresh token is stored and rotated automatically by the
  connections kit.
- New apps run in **sandbox** — add your TikTok account as a target user to test. Until the app is
  approved for the Content Posting API, `tiktok_post_video` can only publish as **SELF_ONLY**
  (private).
- PULL_FROM_URL requires the video URL's domain to be verified on the app for any non-private
  privacy level.
- TikTok deviates from RFC 6749: the client id is sent as `client_key` and authorize scopes are
  comma-separated. The connections kit's `clientIdParam` / `scopeSeparator` adapter options handle
  this.
