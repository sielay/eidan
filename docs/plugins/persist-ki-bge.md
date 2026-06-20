# Persistent Knowledge Index (BGE) · matbot engine plugin

The `persist-ki-bge` plugin replaces matbot's default in-memory knowledge index with one backed by a `Store`, so indexed knowledge entries survive restarts. It scores searches by matching entities and document headings, and can optionally sharpen results with a Cloudflare Workers AI BGE reranker for true semantic ranking. It registers itself as the active `KnowledgeIndex` service, so it transparently powers the agent's knowledge lookups (for example matbot's `contextual_search` tool when the model hits an unknown term) without any tool of its own.

This is a plugin from the matbot engine (Apache-2.0, github.com/MatAtBread/matbot), available to enable in eidan. The agent never calls it directly — it works behind the scenes whenever knowledge is indexed or searched. It runs in both node and browser realms.

## Tools

This plugin exposes no tools. It registers a `KnowledgeIndex` service (backed by a `knowledge` store and the vault) that the rest of the system consumes.

## Example

```
// On install:
"Persistent knowledge index is active. … To enable the reranker, store two
 secrets with the `plugin` tool (action "store-key"): CLOUDFLARE_ACCOUNT_ID
 and SKILL_RANK_API_KEY."
```

A search proceeds in stages: a single entity-name match wins immediately; otherwise entries are scored by heading weight (H1=20, H2=10, H3=5) plus one point per body occurrence; a clear winner (≥2x the runner-up) is returned directly; only ambiguous cases call the BGE reranker.

## Notes

- Indexing is content-hashed (FNV-1a): re-indexing an unchanged entry is a no-op.
- The reranker is optional. Without `SKILL_RANK_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` in the vault, search degrades gracefully to entity- and heading-based scoring.
- The reranker only sees the first 1500 chars of each candidate; the local heading/body scoring sees full content.
- Reranker auth/quota failures are logged (with the offending HTTP status) rather than failing silently, then fall back to heading scoring.
- Final reranked results are trimmed to those covering 50% of the total weight (tunable), surfacing clear winners without long-tail noise.
