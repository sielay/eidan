# Deep Archaeology Procedures

Three promoted procedures for discovering patterns, opportunities, and actionable insights from your archived digital history (Google Drive and email).

## Overview

These procedures enable deep dives into:
- **Drive Deep Scan** — recursively traverse Drive, extract files by type (PDFs, docs, sheets, archives), categorize by date/owner/size, surface old ideas and archived projects
- **Mail Thread Archaeology** — group emails by sender and topic, extract decision patterns, identify customer feedback and partnership leads, detect seasonal trends
- **Idea Extraction Pipeline** — combine Drive and mail findings, extract problems/solutions/opportunities from documents and emails, deduplicate, store in memory for future reference

## Setup

### Prerequisites

These procedures require access to Drive and mail tools. Before promoting, ensure:

1. **Environment variable** — add to `matbot.yaml`:
   ```yaml
   EIDAN_PROCEDURE_TOOLS: gdrive_search,gdrive_read_file,imap_search,imap_read_message,remember,recall
   ```
   (This allows procedures to call the archaeology tools plus memory storage.)

2. **Google Drive connected** — the Drive tools require either:
   - A connected Google account in Settings → Connections (Gmail integration automatically shares Drive access if consent includes `drive.readonly`), OR
   - Legacy fallback: `EIDAN_GOOGLE_CLIENT_ID`, `EIDAN_GOOGLE_CLIENT_SECRET`, `EIDAN_GOOGLE_REFRESH_TOKEN` in Settings → Connections

3. **Email configured** — IMAP tools require:
   - A mail account configured in Settings → Integrations → Mail, OR
   - Legacy env config: `EIDAN_IMAP_*` and `EIDAN_SMTP_*` in Settings → Connections

### Promoting the Procedures

**Option A: Via Chat (Recommended)**

The simplest way is to ask the agent to promote them:

> **You:** Promote the drive_deep_scan, mail_thread_archaeology, and idea_extraction_pipeline procedures for deep content archaeology.

The agent will present each procedure, ask for confirmation, and save them to `eidan.knowledge` under `skill='procedure'`.

**Option B: Via Setup Script**

Use the included setup helper:

```bash
cd packages/procedures
node setup-archaeology.js 00000000-0000-0000-0000-000000000000
```

Replace the UUID with your user ID (find it via `SELECT id FROM eidan.users LIMIT 1;`). The script extracts procedure sources and shows SQL or chat instructions.

**Option C: Direct SQL**

Insert procedures directly into the database:

```sql
INSERT INTO eidan.knowledge (user_id, skill, title, body) VALUES
  ('your-user-id', 'procedure', 'drive_deep_scan', '... JavaScript source ...'),
  ('your-user-id', 'procedure', 'mail_thread_archaeology', '... JavaScript source ...'),
  ('your-user-id', 'procedure', 'idea_extraction_pipeline', '... JavaScript source ...');
```

Procedure sources are exported from `@eidandev/procedures` in the package's `archaeology-procedures.ts`.

## Usage

Once promoted, agents can invoke them directly:

### 1. Drive Deep Scan

```javascript
await callTool('procedures', {
  action: 'run_saved',
  name: 'drive_deep_scan'
});
```

**Returns:** `{timestamp, summary, filesByType, largeFiles, recentModified, potentialIdeas}`

**Use cases:**
- Find all PDFs, docs, sheets organized by type and modification date
- Identify archived projects (keywords: archive, old, draft, ideas, strategy, venture)
- Locate financial records and research materials
- Discover large files (10MB+) that might contain substantial content

**Example output:**
```json
{
  "timestamp": "2026-06-26T...",
  "summary": {
    "totalByType": {"PDFs": 45, "Documents": 120, "Sheets": 23, "Archives": 8},
    "largeFilesCount": 12,
    "datesWithContent": 156
  },
  "potentialIdeas": [
    {"type": "Documents", "signal": "archive", "file": "2022_Projects_Archive.docx", "modified": "2022-11-15T..."},
    {"type": "Archives", "signal": "old", "file": "research_2021.zip", "modified": "2021-06-30T..."}
  ]
}
```

### 2. Mail Thread Archaeology

```javascript
await callTool('procedures', {
  action: 'run_saved',
  name: 'mail_thread_archaeology'
});
```

**Returns:** `{timestamp, summary, topSenders, topTopics, customerSignals, seasonalTrends}`

**Use cases:**
- Identify your most frequent correspondents
- Surface recurring topics and discussion themes
- Extract customer feedback and partnership inquiries
- Analyze seasonal patterns (e.g., when does demand spike for PhoneKills book?)
- Find decision-making patterns across time periods

**Example output:**
```json
{
  "timestamp": "2026-06-26T...",
  "summary": {
    "topSendersCount": 20,
    "uniqueTopicsDiscussed": 187,
    "totalEmailsAnalyzed": 2850,
    "customerSignalCount": 15
  },
  "topSenders": [
    {"name": "alice@partner.com", "count": 143, "lastDate": "2025-12-01T..."},
    {"name": "bob@customer.com", "count": 98, "lastDate": "2025-11-15T..."}
  ],
  "customerSignals": [
    {"sender": "inquiry@startup.com", "keyword": "partnership", "count": 5, "lastDate": "2025-10-12T..."}
  ],
  "seasonalTrends": [
    {"period": "2025-10", "emailCount": 182, "topicsInPeriod": ["PhoneKills book inquiry", "market research", "venture pitch"]}
  ]
}
```

### 3. Idea Extraction Pipeline

```javascript
await callTool('procedures', {
  action: 'run_saved',
  name: 'idea_extraction_pipeline'
});
```

**Returns:** `{timestamp, summary, problems, solutions, opportunities, stored: string}`

**Use cases:**
- Extract problems mentioned across historical documents and emails
- Surface solutions and approaches you've previously attempted
- Identify opportunities and market gaps you've documented
- Automatically store findings in memory under `skill='archaeology'` for future recall

**How it works:**
1. Searches Drive for key document types: business plans, market research, customer feedback, proposals, product ideas, strategies
2. Reads each document and extracts patterns (problems, solutions, opportunities)
3. Searches email for customer signals: feedback, partnerships, inquiries, opportunities
4. Deduplicates findings by normalizing text
5. Stores top discoveries in `eidan.knowledge` under `skill='archaeology'` for automatic recall in future conversations

**Example output:**
```json
{
  "timestamp": "2026-06-26T...",
  "summary": {"problemsFound": 34, "solutionsFound": 28, "opportunitiesFound": 42},
  "problems": [
    {"text": "Developers struggle with API rate limits when building integrations", "source": "Business document: 2022_Market_Analysis.docx"},
    {"text": "Customer onboarding takes 3+ hours due to manual setup", "source": "Email from alice@customer.com: onboarding feedback"}
  ],
  "opportunities": [
    {"text": "Market gap in AI-powered business intelligence for SMBs", "source": "Strategy document: 2023_Ventures_Ideas.docx"}
  ],
  "stored": "Findings have been saved to memory under skill:archaeology"
}
```

## Combining Findings

The three procedures are designed to work independently, but you can orchestrate them together for a complete archaeology run:

```javascript
// Run in sequence: deep scan, extract patterns, pipeline insights
const driveFindings = await callTool('procedures', { action: 'run_saved', name: 'drive_deep_scan' });
const mailPatterns = await callTool('procedures', { action: 'run_saved', name: 'mail_thread_archaeology' });
const ideas = await callTool('procedures', { action: 'run_saved', name: 'idea_extraction_pipeline' });

// Results are now available for further analysis
console.log(`Found ${driveFindings.summary.largeFilesCount} large archives with potential content`);
console.log(`Identified ${mailPatterns.summary.customerSignalCount} customer signals`);
console.log(`Extracted ${ideas.summary.opportunitiesFound} opportunities stored in memory`);
```

## Configuration

### matbot.yaml Example

```yaml
plugins:
  - '@eidandev/procedures'
  - '@eidandev/gdrive'
  - '@eidandev/imap'
  - '@eidandev/memory'

env:
  EIDAN_PROCEDURE_TOOLS: gdrive_search,gdrive_read_file,imap_search,imap_read_message,remember,recall
  EIDAN_DATABASE_URL: postgresql://...
```

### Test Your Setup

After promoting procedures, verify they work:

```
> Run the drive_deep_scan procedure
Agent: Executes procedure, scans Drive, returns file categorization and opportunities
```

## Scheduling

These procedures are perfect for background scheduled runs via the `routines` package:

**Weekly Drive scan (Monday 2am UTC):**
```
> Schedule drive_deep_scan to run every Monday at 2am UTC
Agent: Creates a routine job that runs the procedure on schedule
```

**Monthly mail archaeology (First of month, 3am UTC):**
```
> Schedule mail_thread_archaeology to run monthly on the 1st at 3am UTC
Agent: Sets up monthly pattern analysis and stores trends in memory
```

**Quarterly deep ideas (Jan 1, Apr 1, Jul 1, Oct 1 at midnight):**
```
> Schedule idea_extraction_pipeline to run quarterly
Agent: Creates scheduled quarterly deep reflection and insight extraction
```

Results from scheduled runs are automatically stored in memory under `skill='archaeology'`, making them available for future conversation recall.

## Limitations & Notes

- **File size limit**: Large files (>16KB text) are truncated. The pipelines prioritize breadth over depth per file.
- **Email search**: Limited to recent mail + searches across historical periods. Very old mail (>5 years) may be incomplete if archived.
- **Text extraction**: Works with text-convertible formats (PDFs, Docs, Sheets, plain text). Binary formats (images, video) are skipped.
- **Deduplication**: Simple word-based normalization. Conceptually similar findings may not merge perfectly.
- **Memory storage**: Findings are stored under `skill='archaeology'` and are user-scoped, so they persist across conversations and are rankable by `recall`.

## Example Workflow

**Daily archaeology + research loop:**

1. Agent recalls recent archaeology findings:
   ```
   > Remember the top opportunities we found in the last deep scan?
   Agent: recalls findings from skill:archaeology
   ```

2. Agent uses insights to guide current work:
   ```
   > Based on customer signals we found, let's prioritize the integration problem
   Agent: uses mail findings to inform prioritization
   ```

3. Operator schedules periodic refreshes:
   ```
   > Run deep archaeology again in a week
   Agent: schedules idea_extraction_pipeline for 7 days from now
   ```

## Troubleshooting

### "tool not exposed to procedures"

Procedure tried to call a tool that's not in the allowlist.

**Fix:** Update `EIDAN_PROCEDURE_TOOLS` in `matbot.yaml`:
```yaml
EIDAN_PROCEDURE_TOOLS: gdrive_search,gdrive_read_file,imap_search,imap_read_message,remember,recall
```

### "Google isn't connected"

Drive tools can't find your Google account.

**Fix:** In Settings → Connections, add a Gmail account (Drive access is shared), OR set legacy env keys:
```yaml
env:
  EIDAN_GOOGLE_CLIENT_ID: ...
  EIDAN_GOOGLE_CLIENT_SECRET: ...
  EIDAN_GOOGLE_REFRESH_TOKEN: ...
```

### "IMAP connection failed"

Mail tools can't reach your email server.

**Fix:** In Settings → Integrations → Mail, verify:
- IMAP host is correct (e.g., `imap.gmail.com`)
- Port is correct (usually 993)
- Password is an app password (not your main account password for Gmail)
- Firewall isn't blocking IMAP port

### Procedure times out

Large Drive or mail archives can hit the 30-second timeout.

**Workarounds:**
- Run narrower searches (e.g., specific folder, date range)
- Run procedures during off-peak times
- Batch results: run `drive_deep_scan`, then run `idea_extraction_pipeline` separately on smaller result sets

## Extending

These procedures are templates. You can:

**Modify search strategies:**
- Focus on specific file types (e.g., only `.pdf` and `.xlsx`)
- Narrow date ranges (e.g., last 2 years instead of all-time)
- Search specific senders or subjects

**Enhance pattern extraction:**
- Add domain-specific keywords (e.g., pricing, competitor names, deal terms)
- Extract numerical data (e.g., budget amounts, customer counts)
- Analyze email threads (group by subject, track conversation evolution)

**Improve deduplication:**
- Use `recall` to compare against existing memory before storing duplicates
- Calculate content similarity using more sophisticated algorithms
- Cluster similar items before returning

**Integrate with other tools:**
- Call `mail_send` to summarize findings in an email report
- Use `glue` or other integrations to enrich findings with external data
- Store custom structures in memory beyond `skill='archaeology'`

### Example: Quarterly Revenue Pattern Analysis

```javascript
// Modified mail_thread_archaeology focusing on customer signals
const customerEmails = await callTool('imap_search', { 
  query: 'invoice OR payment OR purchase OR order', 
  limit: 100 
});

// Extract amounts and dates
const transactions = [];
for (const msg of customerEmails.messages) {
  const email = await callTool('imap_read_message', { uid: msg.uid });
  const amounts = email.body.match(/\$[\d,]+(?:\.\d{2})?/g);
  if (amounts) transactions.push({ date: email.date, amounts, from: email.from });
}

// Store seasonal revenue patterns
await callTool('remember', {
  skill: 'revenue-archaeology',
  title: 'Quarterly Revenue Patterns',
  body: '// Custom analysis: revenue signals by quarter'
});
```

## FAQ

**Q: Can I run multiple procedures at once?**
A: Yes. They're independent, so you can parallelize or batch them. Run all three sequentially for a full deep dive, or run individual procedures as needed.

**Q: Are results stored automatically?**
A: `idea_extraction_pipeline` automatically stores findings in memory. The other two just return results; you can manually save interesting discoveries via `remember`.

**Q: What if my Drive has thousands of files?**
A: Procedures limit searches to 30 results per query. They're scoped, not exhaustive. Consider running with narrower queries to surface priority content first.

**Q: Can I delete procedures?**
A: Yes. In the knowledge graph: `DELETE FROM eidan.knowledge WHERE skill='procedure' AND title='name';` or ask the agent to delete by name.

**Q: How often should I run these?**
A: Depends on your use case:
- **Weekly** if you're actively filing and discovering new patterns
- **Monthly** for steady review and trend tracking
- **Quarterly** for deep reflection and strategic planning
- **On-demand** when you need answers to specific questions
