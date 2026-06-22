# Google Trends Plugin

Access Google Trends data for search interest, trending topics, and rising queries.

## Tools

- `google_trends_search(query, timeframe?, limit?)` - Get search interest over time for a term
- `google_trends_topics(limit?)` - Get current trending topics
- `google_trends_rising(query, limit?)` - Get rising queries related to a search term

## Setup

1. Create a Google Cloud project
2. Enable Google Trends API
3. Generate API key
4. Store in vault:
   - `GOOGLE_TRENDS_API_KEY` - Your API key

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
