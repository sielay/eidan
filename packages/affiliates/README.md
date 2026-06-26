# @eidandev/affiliates

Affiliate program discovery agent + multi-program credential management system.

## Features

### Part 1: Affiliate Program Discovery
Monthly scan discovering 25+ affiliate programs across:

**Book Affiliates (high priority):**
- Amazon Associates, KDP
- Kobo, Apple Books, Google Play Books, Smashwords
- Wattpad, BookBaby, IngramSpark
- Scribd, Audible

**Content/Tech Affiliates (long-tail monetization):**
- VPN: NordVPN, ExpressVPN, Surfshark
- Freelance: Fiverr, Upwork
- Education: Skillshare, Udemy, Coursera
- AI: GitHub Copilot, ChatGPT Plus
- Productivity: Notion, Monday.com, Zapier
- Hosting: Netlify, Vercel, AWS

Each program includes:
- Commission rate
- API/URL/pixel-based link formats
- Relevance score (0-10)
- Content type compatibility
- Signup URLs and API documentation

### Part 2: Credential Management & Link Generation
- Secure vault storage for API keys, affiliate IDs, tracking codes
- Automatic affiliate link generation per program
- Context-aware program suggestions based on content keywords
- Approval status tracking (pending → approved → active)
- Revenue potential estimation by content type

## Tools

### `affiliate_programs_list`
List all registered affiliate programs, optionally filtered by category or status.

```
Input:
  category: 'book' | 'content' | 'tech' | 'other' (optional)
  approval_status: 'pending' | 'approved' | 'rejected' | 'active' (optional)

Output: { total, programs: [{name, provider, category, commission_rate, status, relevance_score, ...}] }
```

### `affiliate_program_add`
Register a new affiliate program.

```
Input:
  program_name: string (e.g., "Kobo Affiliates")
  provider: string (e.g., "kobo")
  category: 'book' | 'content' | 'tech' | 'other'
  link_format: 'url' | 'api' | 'pixel'
  commission_rate: number (optional, e.g., 15.5 for 15.5%)
  signup_url: string (optional)
  api_endpoint: string (optional)
  content_types: string[] (optional, e.g., ["video", "article"])
  relevance_score: number (optional, 0-10)

Output: { ok, program_id, program_name }
```

### `affiliate_program_update`
Update a program's approval status, commission rate, or content types.

```
Input:
  program_id: string (required)
  approval_status: 'pending' | 'approved' | 'rejected' | 'active' (optional)
  commission_rate: number (optional)
  relevance_score: number (optional)
  content_types: string[] (optional)

Output: { ok, program_name }
```

### `affiliate_credential_store`
Store encrypted credentials (API key, affiliate ID, tracking code) in the vault.

```
Input:
  program_id: string
  credential_type: 'api_key' | 'affiliate_id' | 'tracking_code' | 'custom'
  vault_key: string (encrypted vault key reference)

Output: { ok, program_name, credential_type }
```

### `affiliate_link_generate`
Generate an affiliate link for a specific content piece.

```
Input:
  program_id: string
  content_id: string (optional)
  content_type: 'video' | 'article' | 'post' | 'podcast' | 'book' | 'other'
  custom_params: object (optional, for custom URL parameters)

Output: { ok, affiliate_link, program_name, content_id }
```

### `affiliate_link_suggest`
Suggest relevant affiliate programs for content based on keywords.

```
Input:
  content_type: 'video' | 'article' | 'post' | 'podcast' | 'book' | 'other'
  keywords: string[] (optional, e.g., ["VPN", "security"])

Output: { content_type, suggestions: [{program_name, provider, category, commission_rate, relevance_score}] }
```

## Database Schema

### `eidan.affiliate_programs`
- `id`, `user_id`, `program_name`, `provider`, `category`
- `commission_rate`, `commission_currency`
- `link_format`, `signup_url`, `api_endpoint`, `api_docs_url`
- `approval_status` (pending/approved/rejected/active)
- `relevance_score`, `content_types`, `metadata`
- Soft-delete: `deleted_at`

### `eidan.affiliate_credentials`
- `id`, `user_id`, `program_id`
- `credential_type` (api_key/affiliate_id/tracking_code/custom)
- `key_vault_key` (encrypted vault reference)
- `status` (active/inactive)
- `last_verified_at`

### `eidan.affiliate_links`
- `id`, `user_id`, `program_id`
- `content_id`, `content_type` (video/article/post/podcast/book/other)
- `generated_link`, `link_type` (direct_url/api_based/tracking_pixel)
- `expires_at`

### `eidan.affiliate_discovery_log`
- Monthly discovery runs with program counts
- `programs_found`, `new_programs`, `source`

## Setup

1. Add to `matbot.yaml` after `vault-postgres`:
```yaml
- ./packages/affiliates
```

2. Optionally pre-populate vault secrets (e.g., `AMAZON_AFFILIATE_ID`, `KOBO_AFFILIATE_ID`)

3. The discovery agent auto-discovers 25+ programs on first use

## Usage Example

```
I'm writing a blog post about VPN security. Which affiliate programs should I include?

→ affiliate_link_suggest({content_type: "article", keywords: ["VPN", "security"]})
→ Suggests: NordVPN (relevance 9.0), ExpressVPN (8.5), Surfshark (8.0)

Generate a link for NordVPN:
→ affiliate_link_generate({program_id: "...", content_id: "vpn-blog-2024", content_type: "article"})
→ Returns: https://affiliate.nordvpn.com/?ref=<your-id>
```

## Integration Points

- **Vault** (@eidandev/vault-postgres): Encrypted credential storage
- **EidanSecrets**: Declares secret fields (API keys, affiliate IDs)
- **Jobs**: Can be invoked as a job handler for scheduled discovery
- **Agents**: Integration with agent workflows for link placement
