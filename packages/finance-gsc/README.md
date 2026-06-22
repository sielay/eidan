# Google Search Console Plugin

Get performance metrics, sitemap status, and indexing information from Google Search Console.

## Tools

- `gsc_performance(site_url, days?, limit?)` - Get search performance (clicks, impressions, CTR, position)
- `gsc_sitemaps(site_url)` - Get submitted sitemaps and their status
- `gsc_indexing(site_url)` - Get indexing status and coverage information

## Setup

1. Add your site to Google Search Console at https://search.google.com/search-console
2. Create a Google Cloud project and enable Search Console API
3. Generate OAuth access token
4. Store in vault:
   - `GSC_ACCESS_TOKEN` - Your OAuth access token

## Example

```
Performance: site_url="https://example.com/", days=28
Sitemaps: site_url="https://example.com/"
Indexing: site_url="https://example.com/"
```

## Query Parameters

**gsc_performance:**
- `site_url` - Site URL (required, e.g., https://example.com/)
- `days` - Date range in days (1-90, default: 28)
- `limit` - Max results (1-100, default: 10)

## Troubleshooting

- **Authentication failed**: Check GSC_ACCESS_TOKEN is valid
- **Site not found**: Verify site is added to Google Search Console
- **No data**: Ensure site has search performance data in GSC
