# Reddit Research Plugin

Search Reddit for market trends and pain points. Agents can discover what users are struggling with across venture-relevant subreddits.

## Setup

1. **Create a Reddit app** at https://reddit.com/prefs/apps:
   - Create a "script" app (not a web app)
   - Note the client ID and client secret

2. **Set credentials** in Eidan's Settings (Secrets):
   - `REDDIT_CLIENT_ID`: Your app's client ID
   - `REDDIT_CLIENT_SECRET`: Your app's secret
   - `REDDIT_REFRESH_TOKEN` (optional): For persistent sessions

## Agent Tools

### `search_reddit(subreddit, keywords, time_window?, limit?)`

Search a subreddit for posts matching keywords.

```typescript
{
  "subreddit": "parenting",           // subreddit name (no r/ prefix)
  "keywords": ["math practice", "homework"],  // OR'd together
  "time_window": 7,                   // days (default 7)
  "limit": 30                         // max results (default 30)
}
```

Returns ranked posts by engagement (upvotes + comments), with sentiment classification.

### `get_trends(venture, days?)`

Summarize trending topics and pain points from cached posts for a venture.

```typescript
{
  "venture": "mathbuns",  // venture slug
  "days": 7              // lookback period (default 7)
}
```

Groups posts by sentiment (frustration, seeking_help, positive) and surfaces top pain points.

### `generate_report(venture, days?)`

Generate a markdown report of market insights.

```typescript
{
  "venture": "mathbuns",  // venture slug
  "days": 7              // lookback period (default 7)
}
```

Returns structured markdown with pain points, help-seeking patterns, and engagement metrics.

## Example Workflow

```
Agent calls: search_reddit("parenting", ["math homework", "learning apps"])
↓
Tool queries Reddit, detects sentiment, caches posts
↓
Agent calls: get_trends("mathbuns", 7)
↓
Tool returns grouped pain points (frustration, seeking help)
↓
Agent calls: generate_report("mathbuns", 7)
↓
Tool returns markdown report → agent embeds in response
```

## Sentiment Detection

Posts are tagged with sentiment based on keyword analysis:
- `frustration`: 2+ frustration keywords (struggling, difficult, broken, etc.)
- `seeking_help`: 1 frustration keyword + explicit help request
- `positive`: mentions of love/great/amazing
- `neutral`: no strong sentiment

## Database

Posts are cached in `eidan.reddit_posts` to avoid re-scraping. One row per (user, post_id). Updates track engagement (score, comments) over time.

Venture-to-subreddit mappings live in `eidan.reddit_ventures` (operator config, not in plugin).
