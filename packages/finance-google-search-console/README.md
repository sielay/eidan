# @eidandev/finance-google-search-console

Google Search Console finance plugin for Eidan: performance metrics, sitemaps, indexing status, and crawl errors via the Google Search Console API with OAuth2.

## Setup

### 1. Create an OAuth2 Application

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Google Search Console API**
4. Create an **OAuth 2.0 Client ID** (Web application):
   - Authorized JavaScript origins: (your Eidan domain)
   - Authorized redirect URIs: `https://your-eidan.com/auth/google/callback` (or similar)
5. Copy the **Client ID** and **Client Secret**

### 2. Generate an OAuth2 Access Token

You can generate an access token using:
- [Google OAuth Playground](https://developers.google.com/oauthplayground) (for testing)
- Your application's OAuth flow
- A script using `google-auth-library-nodejs`

Ensure the token includes the `https://www.googleapis.com/auth/webmasters` scope.

### 3. Configure Eidan Vault Secrets

Via the **Settings UI** (Connections → Google Search Console):

- **GSC_ACCESS_TOKEN**: The OAuth2 access token (from step 2)
- **GSC_PROPERTY_URL**: The property URL registered in GSC (e.g., `https://example.com` or `https://m.example.com`)

Or via environment/gitignored `matbot.yaml`:

```yaml
env:
  GSC_ACCESS_TOKEN: ya29.a0AeDclS...
  GSC_PROPERTY_URL: https://example.com
```

### 4. Add to matbot.yaml

```yaml
plugins:
  - ./packages/finance-google-search-console
```

### 5. Restart Eidan

Verify tools are loaded:

```
[finance-google-search-console] plugin loaded: gsc_performance, gsc_sitemaps, gsc_indexing_status, gsc_indexing_errors, gsc_check_url
```

## Tools

### `gsc_performance`

Get Google Search Console performance data (clicks, impressions, CTR, average position) by page and query.

**Parameters:**

- `days` (optional, 1–90): Number of days of history to fetch (default: 7)
- `limit` (optional, 1–100): Max query/page combinations to return (default: 10)

**Example:**

```json
gsc_performance({
  days: 30,
  limit: 20
})
```

**Response:**

```json
{
  "days": 30,
  "dataPoints": 2,
  "performance": [
    {
      "query": "eidan agent",
      "page": "https://example.com/features",
      "clicks": 45,
      "impressions": 230,
      "ctr": 0.196,
      "avgPosition": 3.2
    },
    {
      "query": "personal ai assistant",
      "page": "https://example.com/",
      "clicks": 12,
      "impressions": 150,
      "ctr": 0.08,
      "avgPosition": 5.1
    }
  ]
}
```

### `gsc_sitemaps`

List all submitted sitemaps with their status, last submission date, and indexed URL count.

**Example:**

```json
gsc_sitemaps()
```

**Response:**

```json
{
  "count": 2,
  "sitemaps": [
    {
      "path": "https://example.com/sitemap.xml",
      "lastSubmitted": "2026-06-20T10:00:00Z",
      "type": "sitemap",
      "indexed": "1250"
    },
    {
      "path": "https://example.com/sitemap-mobile.xml",
      "lastSubmitted": "2026-06-19T08:30:00Z",
      "type": "sitemap",
      "indexed": "1100"
    }
  ]
}
```

### `gsc_indexing_status`

Get the current indexing coverage: total indexed pages, total crawlable pages, and coverage ratio.

**Example:**

```json
gsc_indexing_status()
```

**Response:**

```json
{
  "status": {
    "indexedPages": "1250",
    "totalPages": "1500",
    "coverage": "1250/1500"
  }
}
```

### `gsc_indexing_errors`

Get the latest indexing errors aggregated by type: crawl errors, coverage issues, mobile usability problems, and AMP errors. Returns counts grouped by error type.

**Parameters:**

- `limit` (optional, 1–50): Max error types to return (default: 5)

**Example:**

```json
gsc_indexing_errors({
  limit: 10
})
```

**Response:**

```json
{
  "count": 2,
  "errors": [
    {
      "type": "ROBOTS_TAG",
      "count": "3",
      "severity": "WARNING",
      "example": "Page blocked by robots.txt"
    },
    {
      "type": "CRAWL_ANOMALY",
      "count": "1",
      "severity": "ERROR",
      "example": "Server error (5xx)"
    }
  ]
}
```

### `gsc_check_url`

Inspect a specific URL to check its indexing status, crawl errors, mobile usability issues, and other problems in Google Search Console.

**Parameters:**

- `url` (required): The URL to inspect (e.g., `https://example.com/page`)

**Example:**

```json
gsc_check_url({
  url: "https://example.com/features"
})
```

**Response:**

```json
{
  "url": "https://example.com/features",
  "indexed": true,
  "state": "INDEXED",
  "issues": []
}
```

Or with issues:

```json
{
  "url": "https://example.com/blocked",
  "indexed": false,
  "state": "BLOCKED_BY_ROBOTS_TXT",
  "issues": [
    "BLOCKED_BY_ROBOTS_TXT",
    "RESOURCE_CRAWL_ERROR"
  ]
}
```

## How It Works

1. **OAuth2 Flow**:
   - Access token provided via vault (refresh is manual for now)
   - All requests include `Authorization: Bearer {token}` header
   - If token expires, agent must re-generate and update vault secrets

2. **Credentials**: All secrets stored in Eidan vault (encrypted at-rest via Fernet)
   - Never logged
   - Never exposed in errors
   - Can be rotated by updating vault via Settings UI or environment

3. **API**: Uses the Google Search Console API (`searchconsole.googleapis.com/v1`)
   - Performance: `/sites/{siteUrl}/searchAnalytics/query` (POST)
   - Sitemaps: `/sites/{siteUrl}/sitemaps` (GET)
   - Indexing Status: `/sites/{siteUrl}/inspectionIndex/coverage` (GET)
   - Indexing Errors: `/sites/{siteUrl}/inspectionIndex/errors` (GET)

## Troubleshooting

### "GSC isn't connected"

Ensure both secrets are set:

```
GSC_ACCESS_TOKEN: <not set>
GSC_PROPERTY_URL: <not set>
```

Generate a new access token and update the vault via Settings UI.

### "Invalid property URL"

Ensure `GSC_PROPERTY_URL` matches exactly how it's registered in Google Search Console:

- Trailing slash: some properties have `/`, others don't
- Protocol: `https://example.com` vs `http://example.com`
- Mobile: `https://m.example.com` vs desktop

Check your GSC settings to confirm the exact property URL.

### "Access token expired"

OAuth2 access tokens typically expire after 1 hour. Generate a new token and update the vault:

1. Generate a fresh token at [Google OAuth Playground](https://developers.google.com/oauthplayground)
2. Update `GSC_ACCESS_TOKEN` in Eidan Settings UI or environment

(Future: auto-refresh tokens if refresh token is stored in vault)

### "No data returned"

- Verify the property URL is correct in GSC
- Ensure the property has at least 7 days of data (GSC requires minimum history)
- Check that the OAuth2 token includes the `webmasters` scope

## Architecture

- **client.ts**: Google Search Console API client (fetch-based, no SDK)
- **tools.ts**: Agent tools (performance, sitemaps, indexing, errors)
- **vault.ts**: Secret resolution from matbot vault + env
- **types.ts**: TypeScript definitions for GSC API responses
- **index.ts**: Plugin registration + secret declarations

## API Limits

- Performance queries: up to 90 days of history
- Sitemaps: typically 100+ sitemaps per property
- Indexing status: updated daily by Google
- Errors: latest crawl data only
- Rate limit: Google Search Console API standard quotas apply

## Example Agent Usage

```
Agent: Check the performance of our website over the last 30 days.

Agent → gsc_performance({
  days: 30,
  limit: 20
})

Result:
{
  "days": 30,
  "dataPoints": 5,
  "performance": [
    {
      "query": "eidan",
      "page": "https://example.com",
      "clicks": 120,
      "impressions": 450,
      "ctr": 0.267,
      "avgPosition": 2.8
    },
    ...
  ]
}

Agent: List all our sitemaps and their status.

Agent → gsc_sitemaps()

Result:
{
  "count": 2,
  "sitemaps": [
    {
      "path": "https://example.com/sitemap.xml",
      "lastSubmitted": "2026-06-20T10:00:00Z",
      "type": "sitemap",
      "indexed": "1250"
    },
    ...
  ]
}

Agent: Get the current indexing status.

Agent → gsc_indexing_status()

Result:
{
  "status": {
    "indexedPages": "1250",
    "totalPages": "1500",
    "coverage": "1250/1500"
  }
}

Agent: What indexing errors does Google report?

Agent → gsc_indexing_errors({
  limit: 10
})

Result:
{
  "count": 2,
  "errors": [
    {
      "type": "ROBOTS_TAG",
      "count": "3",
      "severity": "WARNING"
    },
    ...
  ]
}

Agent: Is the page at https://example.com/features indexed?

Agent → gsc_check_url({
  url: "https://example.com/features"
})

Result:
{
  "url": "https://example.com/features",
  "indexed": true,
  "state": "INDEXED",
  "issues": []
}
```

## Future Enhancements

- Auto-refresh OAuth2 tokens (store refresh token in vault)
- Rich card validation (structured data)
- Mobile usability metrics
- Core Web Vitals integration
- Alert subscriptions
- Link analytics (top linking sites)
- Multi-property dashboard (compare 2+ properties)
- Scheduled reports (via routines)

## Limitations

- **Token refresh**: Access tokens expire after ~1h; refresh is manual for now (future: auto-refresh with stored refresh token)
- **Property URL sensitivity**: Must match exactly as registered in GSC
- **Minimum history**: GSC requires at least 1 day of data before any metrics show
- **API quotas**: Subject to Google's API rate limits (typically very generous for small-scale use)
