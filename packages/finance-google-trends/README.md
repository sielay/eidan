# @eidandev/finance-google-trends

Google Trends finance plugin for eidan. Access search volume trends, top trending searches, rising queries, and related search terms via Google Trends public endpoints.

## Features

- **Search Volume Trends**: Get search interest over time for any query (1 hour to 5 years)
- **Top Charts**: Discover top trending searches by category and region
- **Rising Queries**: Find emerging, rapidly growing search terms
- **Related Searches**: Get related queries and topics for any search term

## Tools

### `google_trends_search`

Get search volume trends over time for a query.

**Input:**
```json
{
  "query": "Bitcoin",
  "timeframe": "30d",
  "geo": "US",
  "category": "0"
}
```

**Parameters:**
- `query` (required): Search term to track (e.g., "Bitcoin", "AI", "renewable energy")
- `timeframe` (optional): Time period (default: "30d")
  - `1h`: Last hour
  - `4h`: Last 4 hours
  - `1d`: Last day
  - `7d`: Last 7 days
  - `30d`: Last 30 days (default)
  - `90d`: Last 90 days
  - `1y`: Last year
  - `5y`: Last 5 years
- `geo` (optional): Geographic region by ISO-3166 code (e.g., "US", "GB", "IN"). Default: worldwide
- `category` (optional): Trend category number (e.g., "0" for all, "71" for Business & Finance). Default: "0"

**Output:**
```json
{
  "query": "Bitcoin",
  "timeframe": "30d",
  "geo": "US",
  "category": "0",
  "trend_count": 30,
  "trends": [
    { "date": "20240101", "value": 45 },
    { "date": "20240102", "value": 52 }
  ]
}
```

### `google_trends_top_charts`

Get top trending searches by category and region.

**Input:**
```json
{
  "category": "0",
  "geo": "US",
  "date": ""
}
```

**Parameters:**
- `category` (optional): Trend category (default: "0" for all)
- `geo` (optional): Geographic region (default: worldwide)
- `date` (optional): Specific date in YYYYMM format (e.g., "202406"). Default: today

**Output:**
```json
{
  "category": "0",
  "geo": "US",
  "date": "(today)",
  "chart_count": 25,
  "charts": [
    {
      "title": "Taylor Swift",
      "url": "https://trends.google.com/...",
      "growth_percent": 125
    }
  ]
}
```

### `google_trends_rising_queries`

Get rising/emerging search queries with anomalies.

**Input:**
```json
{
  "category": "71",
  "geo": "US"
}
```

**Parameters:**
- `category` (optional): Trend category (default: "0" for all)
- `geo` (optional): Geographic region (default: worldwide)

**Output:**
```json
{
  "category": "71",
  "geo": "US",
  "query_count": 50,
  "rising_queries": [
    { "query": "Bitcoin ETF", "interest_value": 500 },
    { "query": "Tech stocks", "interest_value": 480 }
  ]
}
```

### `google_trends_related`

Get related search queries and topics for a given query.

**Input:**
```json
{
  "query": "AI",
  "geo": "US"
}
```

**Parameters:**
- `query` (required): Search term to find related queries for
- `geo` (optional): Geographic region (default: worldwide)

**Output:**
```json
{
  "query": "AI",
  "geo": "US",
  "related_queries": [
    { "query": "artificial intelligence", "interest_value": 95 },
    { "query": "machine learning", "interest_value": 88 }
  ],
  "related_topics": [
    { "topic": "Artificial Intelligence", "interest_value": 100 },
    { "topic": "Machine Learning", "interest_value": 85 }
  ]
}
```

## Setup

No authentication required for public Google Trends API. The plugin uses public endpoints (trends.google.com).

### Optional: API Key

For increased rate limits or access to premium endpoints, optionally configure:

```
GOOGLE_TRENDS_API_KEY=your-api-key-here
```

Store this in the vault via the Settings UI (Settings → Secrets → Google Trends).

## Geographic Codes

Common ISO-3166 country/region codes:

| Code | Region |
|------|--------|
| US | United States |
| GB | United Kingdom |
| IN | India |
| DE | Germany |
| FR | France |
| JP | Japan |
| AU | Australia |
| CA | Canada |
| BR | Brazil |
| MX | Mexico |

## Category Codes

Common category numbers:

| Code | Category |
|------|----------|
| 0 | All Categories (default) |
| 71 | Business & Finance |
| 12 | Computers & Electronics |
| 8 | Finance |
| 13 | Games |
| 14 | Hobbies |
| 68 | Investing & Finance |
| 3 | News & Events |
| 1 | Arts & Entertainment |

## Examples

### Track Bitcoin price discussions over 90 days

```
google_trends_search(
  query="Bitcoin price",
  timeframe="90d",
  geo="US",
  category="71"
)
```

### Find emerging fintech topics

```
google_trends_rising_queries(
  category="71",
  geo="US"
)
```

### Discover related cryptocurrency queries

```
google_trends_related(
  query="cryptocurrency",
  geo="US"
)
```

### Compare market sentiment by region

```
google_trends_search(
  query="stock market",
  timeframe="7d",
  geo="GB"
)
```

## Rate Limiting

Google Trends public API has implicit rate limiting:

- **5-10 requests per minute** per IP/session recommended
- High-frequency requests (>100/min) may result in temporary IP blocks
- Use appropriate delays between calls in automation

## Limitations

- Public API provides aggregated, anonymized data
- Historical data has a ~90-day retention window
- Real-time data may lag by 1-2 hours
- Some regions/categories may have limited data availability
- Search interest values are normalized (0-100 scale)
- **Scraping fragility**: This plugin scrapes undocumented Google Trends endpoints. Google frequently changes its front-end structure, which can invalidate the parsing logic without warning. Parse errors indicate Google may have changed the API response format. If you encounter persistent parsing errors, the plugin may need updates to adapt to Google's changes.

## Error Handling

All tools yield errors instead of throwing. Common error scenarios:

| Error | Cause | Resolution |
|-------|-------|-----------|
| HTTP 429 | Rate limit exceeded | Wait and retry after delay |
| HTTP 503 | Google Trends service unavailable | Retry after 60 seconds |
| Parse error | Unexpected response format | Report issue; may indicate API changes |
| Network timeout | Connection issue | Check internet connectivity and retry |

## Testing

Run tests with:

```bash
pnpm --filter @eidandev/finance-google-trends test
```

Tests include:

- Client initialization and method validation
- Tool schema and input validation
- Vault secret resolution
- Error handling paths

## Troubleshooting

**No trends data returned?**
- Verify query is not too niche (very specific terms have limited data)
- Try with a broader geographic region
- Check timeframe contains data (very recent data may lag)

**High latency?**
- Space requests by 1-2 seconds minimum
- Consider caching results for repeated queries
- Use smaller timeframes for faster responses

**Rate limiting?**
- Reduce request frequency
- Implement exponential backoff with 30-60s delays
- Distribute requests across time

## Resources

- [Google Trends](https://trends.google.com)
- [Category Codes Reference](https://github.com/GeneralMills/pytrends/blob/master/pytrends/dailydata.py)
- [ISO-3166 Country Codes](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2)
