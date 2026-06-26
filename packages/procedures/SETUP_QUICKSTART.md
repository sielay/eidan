# Deep Archaeology Procedures — Quick Start

Three new procedures for discovering patterns and opportunities in your archived Drive and email content.

## What's New

📦 **Three ready-to-use procedures:**
- `drive_deep_scan` — Categorize all Drive files by type, date, size; surface old projects
- `mail_thread_archaeology` — Extract customer signals, seasonal trends, decision patterns from email
- `idea_extraction_pipeline` — Read discovered content, extract opportunities, store findings in memory

## Install (5 minutes)

### 1. Configure matbot.yaml

Add the procedure tools allowlist:

```yaml
plugins:
  - '@eidandev/procedures'
  - '@eidandev/gdrive'
  - '@eidandev/imap'
  - '@eidandev/memory'

env:
  EIDAN_PROCEDURE_TOOLS: gdrive_search,gdrive_read_file,imap_search,imap_read_message,remember,recall
```

### 2. Verify Drive & Mail Access

- **Drive:** Settings → Connections → Add Gmail account (or set `EIDAN_GOOGLE_*` secrets)
- **Mail:** Settings → Integrations → Mail → Add email account (or set `EIDAN_IMAP_*` secrets)

### 3. Promote Procedures

**Easiest way:** In chat, ask the agent:

> Promote the drive_deep_scan, mail_thread_archaeology, and idea_extraction_pipeline procedures to the knowledge graph.

Agent will confirm and save them. Done!

**Alternative:** Run the setup script:

```bash
cd packages/procedures
node setup-archaeology.js YOUR_USER_ID
```

(Find your user ID: `SELECT id FROM eidan.users LIMIT 1;`)

## Use (30 seconds per procedure)

Once promoted, in chat:

```
> Run the drive_deep_scan procedure
Agent: Scans Drive, returns files organized by type/date/size + opportunities
Result: ~300 files found, 12 large archives (10MB+), 30 archived projects with keywords

> Run the mail_thread_archaeology procedure
Agent: Analyzes email history, surfaces patterns
Result: Top 20 senders, 187 unique topics, 15 customer signals, seasonal trends by quarter

> Run the idea_extraction_pipeline procedure
Agent: Extracts problems, solutions, opportunities from documents and emails
Result: 34 problems, 28 solutions, 42 opportunities stored in memory for future recall
```

## Schedule (optional, one-time setup)

Ask the agent to run procedures on a schedule:

```
> Schedule drive_deep_scan to run every Monday at 2am UTC
> Schedule mail_thread_archaeology to run monthly on the 1st
> Schedule idea_extraction_pipeline to run quarterly
```

Results automatically store in memory and are available for future conversations.

## Acceptance Criteria — Met ✅

- ✅ Procedures run in sandbox (isolated-vm, no external network)
- ✅ Access only allowlisted tools (gdrive_search, imap_search, remember, etc.)
- ✅ Drive scanner finds PDFs, docs, sheets, archives by type + modification date
- ✅ Mail archaeology groups by sender + topic, extracts themes
- ✅ Idea pipeline deduplicates findings, tags with skill='archaeology'
- ✅ Output stored in `eidan.knowledge` for future recall
- ✅ Can be run on-demand (chat) or scheduled (background jobs)

## File Structure

```
packages/procedures/
├── src/
│   ├── archaeology-procedures.ts  # ← Three procedure templates
│   └── index.ts                    # ← Exports procedures
├── ARCHAEOLOGY.md                  # ← Full documentation
├── SETUP_QUICKSTART.md            # ← This file
├── setup-archaeology.js            # ← Bootstrap helper
└── README.md                        # ← Updated with overview
```

## Troubleshooting

**"tool not exposed"** → Update `EIDAN_PROCEDURE_TOOLS` in matbot.yaml

**"Google isn't connected"** → Add Gmail account in Settings or set `EIDAN_GOOGLE_*` secrets

**"IMAP connection failed"** → Verify mail account in Settings → Integrations, use app password for Gmail

**"timeout"** → Large archives can hit 30s limit; run with narrower searches or in batches

See [ARCHAEOLOGY.md](./ARCHAEOLOGY.md) for full troubleshooting and FAQs.

## Next Steps

1. ✅ Update matbot.yaml with tool allowlist
2. ✅ Connect Google + Mail accounts
3. ✅ Run `drive_deep_scan` to surface old files
4. ✅ Run `mail_thread_archaeology` to find patterns
5. ✅ Run `idea_extraction_pipeline` to discover opportunities
6. 🎯 Use findings to inform future decisions
7. ✅ (Optional) Schedule for weekly/monthly/quarterly repeats

---

**Questions?** See [ARCHAEOLOGY.md](./ARCHAEOLOGY.md) for comprehensive docs, examples, and extending procedures.
