# Google Trends Plugin

⚠️ **IMPORTANT: This plugin uses reverse-engineered, unofficial Google Trends API endpoints. They are subject to breakage without notice.**

Access Google Trends data for search interest, trending topics, and rising queries. For production use, consider official alternatives like [SerpAPI](https://serpapi.com/docs/google-trends-api) or [ValueSerps](https://www.valueserps.com/google-trends-api).

## Tools

- `google_trends_search(query, timeframe?, limit?)` - Get search interest over time for a term
- `google_trends_topics(limit?)` - Get current trending topics
- `google_trends_rising(query, limit?)` - Get rising queries related to a search term

## Setup

⚠️ Note: Google does not officially provide a public Trends API. This plugin uses reverse-engineered endpoints from the Trends website.

1. Obtain an API key (e.g., from Google Cloud or use a generic placeholder)
2. Store in vault:
   - `GOOGLE_TRENDS_API_KEY` - API key for accessing reverse-engineered endpoints

## Example

```
Search: query="machine learning", timeframe="now 30-d"
Topics: Get trending topics
Rising: query="AI", find rising queries
```

## Timeframe Examples

- `now 1-d` - Past day
- `now 7-d` - Past 7 days
- `now 30-d` - Past 30 days
- `now 90-d` - Past 90 days
- `now 12-m` - Past 12 months
- `2020-01-01 2020-12-31` - Custom date range

## Troubleshooting

- **Authentication failed**: Check GOOGLE_TRENDS_API_KEY is valid
- **API limit exceeded**: Google Trends has rate limits
- **No data**: Try different timeframe or query term
- **API errors / endpoints broken**: Google frequently updates its website; reverse-engineered endpoints may break without notice. If this occurs, consider migrating to an official third-party service (SerpAPI, ValueSerps) which maintain stable APIs.
