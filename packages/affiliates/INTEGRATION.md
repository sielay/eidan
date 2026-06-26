# Affiliate System Integration Guide

## Quick Start

### 1. Enable the Plugin

Add to your `matbot.yaml` (after `vault-postgres`):

```yaml
  - ./packages/vault-postgres
  - ./packages/affiliates  # <-- Add here
  - ./packages/llm-calls
```

### 2. Run the Migration

```bash
pnpm --filter @eidandev/migrate migrate
```

This creates:
- `eidan.affiliate_programs` — the program catalog
- `eidan.affiliate_credentials` — vault references for API keys/IDs
- `eidan.affiliate_links` — generated links with expiry
- `eidan.affiliate_discovery_log` — discovery run history

### 3. (Optional) Pre-populate Vault Secrets

The plugin declares these secrets in EidanSecrets:

```
AMAZON_AFFILIATE_ID       → Your Amazon Associates tag (e.g., "your-tag-20")
KOBO_AFFILIATE_ID         → Your Kobo affiliate ID
NORDVPN_AFFILIATE_ID      → Your NordVPN partner ID
SKILLSHARE_AFFILIATE_ID   → Your Skillshare ID
UDEMY_AFFILIATE_ID        → Your Udemy ID
```

Store these in your vault (Settings UI or `secrets-api`), or they'll be prompted when you first use the tool.

### 4. Discover Programs

On first use, the agent will auto-discover 25+ programs via `affiliate_link_suggest` or a manual call:

```
You: "Find all active affiliate programs I can use"
→ affiliate_programs_list({approval_status: "active"})
```

For custom discovery runs, use the discovery service (if exposed as a job handler).

## Common Workflows

### Workflow 1: Register a new program

```
You: "Add Coursera to my affiliate programs. Commission is 45%, and I want to use it for tutorial content."

Tool calls:
1. affiliate_program_add({
     program_name: "Coursera",
     provider: "coursera",
     category: "tech",
     link_format: "url",
     commission_rate: 45,
     signup_url: "https://www.coursera.org/affiliate",
     content_types: ["video", "article"],
     relevance_score: 9
   })
2. affiliate_credential_store({
     program_id: "<returned id>",
     credential_type: "affiliate_id",
     vault_key: "<your-coursera-id>"
   })
```

### Workflow 2: Generate a link for content

```
You: "I wrote an article about learning Python. Generate a Coursera link."

Tool calls:
1. affiliate_link_generate({
     program_id: "<coursera-id>",
     content_id: "python-learning-guide-2024",
     content_type: "article",
     custom_params: {utm_campaign: "blog"}
   })

Result:
→ https://www.coursera.org/affiliate?ref=<your-id>
```

### Workflow 3: Get suggestions for content

```
You: "I'm writing about remote work tools. What affiliates should I mention?"

Tool calls:
affiliate_link_suggest({
  content_type: "article",
  keywords: ["remote", "work", "tools", "productivity"]
})

Result:
→ Suggests: Notion, Monday.com, Zapier, Slack (if any have been approved)
```

## Architecture Integration Points

### Vault (`vault-postgres`)
Credentials are stored encrypted in `eidan.secrets_vault` via vault key references. The plugin uses the standard EidanSecrets UI for key management.

### Jobs (`@eidandev/jobs`)
The discovery pipeline can be triggered as a job handler for scheduled monthly scans. Example:

```typescript
// In your job handler config:
{
  kind: 'affiliate_discovery',
  handler: async (services) => {
    const discovery = services.AffiliateDiscovery;
    const programs = await discovery?.discoverPrograms(userId);
  }
}
```

### Agents (Custom Integration)
To auto-place affiliate links in agent responses:

```typescript
// In your agent/tool plugin
import type { AffiliateDb } from '@eidandev/affiliates/src/db';

// Get suggestions:
const suggestions = await affiliate_link_suggest({
  content_type: "post",
  keywords: contentKeywords
});

// Generate link for each relevant program
for (const program of suggestions) {
  const link = await affiliate_link_generate({
    program_id: program.id,
    content_id: conversationId,
    content_type: "post"
  });
  // Inject link into agent response
}
```

### Procedures (`@eidandev/procedures`)
Affiliate tools can be whitelisted in `EIDAN_PROCEDURE_TOOLS` to allow agent-authored procedures to generate links:

```bash
EIDAN_PROCEDURE_TOOLS=remember,recall,affiliate_link_generate,affiliate_link_suggest
```

## Monitoring & Reporting

Check discovery history:

```sql
SELECT * FROM eidan.affiliate_discovery_log WHERE user_id = 'your-user-id' ORDER BY discovered_at DESC LIMIT 10;
```

Track active programs:

```sql
SELECT program_name, provider, commission_rate, approval_status, relevance_score
FROM eidan.affiliate_programs
WHERE user_id = 'your-user-id' AND deleted_at IS NULL AND approval_status = 'active'
ORDER BY relevance_score DESC;
```

Track generated links:

```sql
SELECT content_type, COUNT(*) as total_links
FROM eidan.affiliate_links
WHERE user_id = 'your-user-id'
GROUP BY content_type;
```

## Troubleshooting

### "No credentials stored for this program"

The link generation tool requires at least one credential (API key, affiliate ID, or tracking code) to be stored. Use `affiliate_credential_store` first.

### Links not generating

Check:
1. Program approval status (must be 'active' for suggestions)
2. Link format (url/api/pixel) — some formats have special handling
3. Credentials exist and are properly encrypted in vault

### Discovery showing no new programs

The discovery catalog is static and checks existing providers. To add custom programs, use `affiliate_program_add` directly.

## Security Notes

- All credentials are encrypted in the vault (never in logs or tool results)
- The `key_vault_key` is a reference; the actual secret is stored by the vault backend
- Links are recorded per content_id for tracking (no sensitive data)
- Soft-delete is used for program archival (deleted_at IS NULL in queries)
