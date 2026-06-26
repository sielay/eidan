// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deep archaeology procedures for Drive and Mail.
 * These are JavaScript source code templates designed to be promoted into the knowledge graph
 * and invoked by agents. Requires EIDAN_PROCEDURE_TOOLS to include: gdrive_search, imap_search,
 * imap_read_message, gdrive_read_file, remember, recall.
 */

export const driveDeepScan = `
// Scan Google Drive for files by type, extract metadata, surface patterns and opportunities.
// Groups files by type, date, and size. Useful for: finding archived projects, old business plans,
// financial data, research materials, and forgotten content.

const fileTypes = {
  PDFs: ['.pdf'],
  Documents: ['.docx', '.doc', '.txt', '.md'],
  Sheets: ['.xlsx', '.xls', '.csv'],
  Archives: ['.zip', '.tar', '.gz', '.rar'],
  Presentations: ['.pptx', '.ppt'],
  Images: ['.jpg', '.jpeg', '.png', '.gif'],
  Videos: ['.mp4', '.mov', '.avi'],
  Audio: ['.mp3', '.wav', '.m4a'],
};

const results = {
  filesByType: {},
  byDate: {},
  largeFiles: [],
  recentModified: [],
  potentialIdeas: [],
};

// Initialize type buckets
for (const type of Object.keys(fileTypes)) {
  results.filesByType[type] = [];
}

// Search for each file type
console.log('Starting Drive deep scan...');
for (const [typeName, extensions] of Object.entries(fileTypes)) {
  for (const ext of extensions) {
    try {
      const search = await callTool('gdrive_search', {
        query: \`filename:\\*\${ext}\`,
        limit: 30,
      });

      if (search.files) {
        for (const file of search.files) {
          const typeData = {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime,
            owner: file.owner,
            size: file.size,
            webViewLink: file.webViewLink,
          };

          results.filesByType[typeName].push(typeData);

          // Track by year/month
          if (file.modifiedTime) {
            const date = file.modifiedTime.split('T')[0]; // YYYY-MM-DD
            if (!results.byDate[date]) results.byDate[date] = [];
            results.byDate[date].push(typeData);
          }

          // Track large files (potential archives with lots of content)
          if (file.size && parseInt(file.size) > 10000000) { // 10MB+
            results.largeFiles.push(typeData);
          }
        }
      }
    } catch (e) {
      console.log(\`Error searching for \${typeName} (\${ext}): \${e.message}\`);
    }
  }
}

// Sort by date
results.recentModified = Object.entries(results.byDate)
  .sort((a, b) => b[0].localeCompare(a[0]))
  .slice(0, 10)
  .flatMap(([date, files]) => files);

// Extract potential ideas: old project folders, archived topics
console.log('Extracting opportunity signals...');
const projectKeywords = ['project', 'archive', 'old', 'draft', 'ideas', 'research', 'plan', 'strategy', 'business', 'venture', 'startup'];
for (const typeName of Object.keys(results.filesByType)) {
  for (const file of results.filesByType[typeName].slice(0, 50)) {
    const lowerName = file.name.toLowerCase();
    for (const keyword of projectKeywords) {
      if (lowerName.includes(keyword)) {
        results.potentialIdeas.push({
          type: typeName,
          signal: keyword,
          file: file.name,
          modified: file.modifiedTime,
          link: file.webViewLink,
        });
        break;
      }
    }
  }
}

return {
  timestamp: new Date().toISOString(),
  summary: {
    totalByType: Object.entries(results.filesByType).reduce((acc, [k, v]) => ({...acc, [k]: v.length}), {}),
    largeFilesCount: results.largeFiles.length,
    datesWithContent: Object.keys(results.byDate).length,
  },
  filesByType: results.filesByType,
  largeFiles: results.largeFiles.slice(0, 20),
  recentModified: results.recentModified.slice(0, 15),
  potentialIdeas: results.potentialIdeas.slice(0, 30),
};
`;

export const mailThreadArchaeology = `
// Analyze email history to surface decision patterns, customer signals, and seasonal trends.
// Groups emails by sender and topic. Extracts: who are key correspondents, what topics recur,
// when do certain themes appear (seasonal patterns), what customer feedback or partnership leads exist.

const senders = {};
const topics = {};
const patterns = {};
const customerSignals = [];
const seasonalTrends = {};

// Search for older emails (multiple time periods)
const queries = [
  'before:2024 after:2023', // 2023
  'before:2023 after:2022', // 2022
  'before:2022 after:2021', // 2021
  '',                        // recent
];

console.log('Searching email history across time periods...');
for (const query of queries) {
  try {
    const search = await callTool('imap_search', {
      query: query || 'all',
      limit: 50,
    });

    if (search.messages) {
      for (const msg of search.messages) {
        // Extract sender
        const fromMatch = msg.from?.match(/[^<]+/) || ['Unknown'];
        const sender = fromMatch[0].trim();

        if (!senders[sender]) {
          senders[sender] = { count: 0, subjects: [], dates: [], uids: [] };
        }
        senders[sender].count++;
        senders[sender].subjects.push(msg.subject);
        senders[sender].dates.push(msg.date);
        senders[sender].uids.push(msg.uid);

        // Extract topic from subject
        const subjectWords = (msg.subject || '').toLowerCase()
          .split(/[\\s\\W]+/)
          .filter(w => w.length > 3 && !['that', 'this', 'from', 'with', 'about', 'been', 'have', 'your', 'their'].includes(w));

        for (const word of subjectWords) {
          if (!topics[word]) topics[word] = [];
          topics[word].push({
            sender,
            subject: msg.subject,
            date: msg.date,
            uid: msg.uid,
          });
        }

        // Track seasonal patterns (month-year from subject)
        if (msg.date) {
          const monthYear = msg.date.substring(0, 7); // YYYY-MM
          if (!seasonalTrends[monthYear]) seasonalTrends[monthYear] = [];
          seasonalTrends[monthYear].push({
            subject: msg.subject,
            sender,
          });
        }
      }
    }
  } catch (e) {
    console.log(\`Error searching with query '\${query}': \${e.message}\`);
  }
}

// Sort senders by frequency
const topSenders = Object.entries(senders)
  .map(([name, data]) => ({name, ...data}))
  .sort((a, b) => b.count - a.count)
  .slice(0, 20);

// Sort topics by frequency
const topTopics = Object.entries(topics)
  .map(([word, mentions]) => ({word, count: mentions.length, examples: mentions.slice(0, 3)}))
  .sort((a, b) => b.count - a.count)
  .slice(0, 30);

// Analyze customer signals (extract from subject/sender patterns)
for (const [sender, data] of Object.entries(senders)) {
  const subjectText = data.subjects.join(' ').toLowerCase();
  const customerKeywords = ['problem', 'issue', 'help', 'bug', 'error', 'feedback', 'inquiry', 'question', 'interested', 'opportunity', 'partnership', 'collaboration'];

  for (const keyword of customerKeywords) {
    if (subjectText.includes(keyword)) {
      customerSignals.push({
        sender,
        keyword,
        count: data.count,
        lastDate: data.dates[data.dates.length - 1],
      });
      break;
    }
  }
}

// Seasonal trend analysis
const seasonalAnalysis = Object.entries(seasonalTrends)
  .sort(([a], [b]) => a.localeCompare(b))
  .slice(-12) // last 12 months
  .map(([period, emails]) => ({
    period,
    emailCount: emails.length,
    topicsInPeriod: [...new Set(emails.map(e => e.subject))].slice(0, 3),
  }));

return {
  timestamp: new Date().toISOString(),
  summary: {
    topSendersCount: topSenders.length,
    uniqueTopicsDiscussed: Object.keys(topics).length,
    totalEmailsAnalyzed: Object.values(senders).reduce((sum, s) => sum + s.count, 0),
    customerSignalCount: customerSignals.length,
  },
  topSenders,
  topTopics,
  customerSignals: customerSignals.slice(0, 20),
  seasonalTrends: seasonalAnalysis,
};
`;

export const ideaExtractionPipeline = `
// Extract actionable insights from archived Drive files and emails.
// Reads discovered documents and emails to identify:
// - Problems mentioned (pain points, frustrations)
// - Solutions proposed (approaches attempted, ideas tested)
// - Opportunities identified (market gaps, customer requests, seasonal patterns)
// Deduplicates findings and stores in memory for future reference.

const findings = {
  problems: [],
  solutions: [],
  opportunities: [],
};

// Helper to extract problems, solutions, opportunities from text
function parseContent(text, source) {
  const patterns = {
    problems: /(?:problem|issue|pain|struggle|difficult|challenging|pain point|frustrated|help|broken|error|bug)s?[:\\s]+([^.!?]*[.!?])/gi,
    solutions: /(?:solution|approach|try|tried|implement|built|created|using|approach|method)s?[:\\s]+([^.!?]*[.!?])/gi,
    opportunities: /(?:opportunity|market|potential|idea|could|should|if we|consider|experiment|new|expansion)s?[:\\s]+([^.!?]*[.!?])/gi,
  };

  const extracted = {};
  for (const [type, pattern] of Object.entries(patterns)) {
    extracted[type] = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
      extracted[type].push({
        text: match[1].trim().substring(0, 200),
        source,
      });
    }
  }
  return extracted;
}

// Search Drive for key document types
const docSearches = [
  { query: 'business plan', type: 'Business' },
  { query: 'market research', type: 'Research' },
  { query: 'customer feedback', type: 'Customer' },
  { query: 'project proposal', type: 'Project' },
  { query: 'product idea', type: 'Product' },
  { query: 'strategy', type: 'Strategy' },
];

console.log('Scanning Drive for key documents...');
for (const search of docSearches) {
  try {
    const results = await callTool('gdrive_search', {
      query: search.query,
      limit: 15,
    });

    if (results.files) {
      for (const file of results.files.slice(0, 5)) {
        try {
          const content = await callTool('gdrive_read_file', {
            file_id: file.id,
          });

          if (content.content) {
            const parsed = parseContent(content.content, \`\${search.type} document: \${file.name}\`);
            findings.problems.push(...parsed.problems);
            findings.solutions.push(...parsed.solutions);
            findings.opportunities.push(...parsed.opportunities);
          }
        } catch (e) {
          console.log(\`Could not read file \${file.name}: \${e.message}\`);
        }
      }
    }
  } catch (e) {
    console.log(\`Error searching for '\${search.query}': \${e.message}\`);
  }
}

// Search mail for customer feedback and opportunities
console.log('Scanning email for insights...');
const emailSearches = [
  'customer feedback',
  'partnership',
  'inquiry',
  'interested',
  'opportunity',
  'problem',
  'issue',
];

for (const query of emailSearches) {
  try {
    const results = await callTool('imap_search', {
      query,
      limit: 10,
    });

    if (results.messages) {
      for (const msg of results.messages.slice(0, 3)) {
        try {
          const email = await callTool('imap_read_message', {
            uid: msg.uid,
          });

          if (email.body) {
            const parsed = parseContent(email.body, \`Email from \${email.from}: \${email.subject}\`);
            findings.problems.push(...parsed.problems);
            findings.solutions.push(...parsed.solutions);
            findings.opportunities.push(...parsed.opportunities);
          }
        } catch (e) {
          console.log(\`Could not read email: \${e.message}\`);
        }
      }
    }
  } catch (e) {
    console.log(\`Error searching email for '\${query}': \${e.message}\`);
  }
}

// Deduplicate by normalizing text (simple word-based dedup)
function deduplicate(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const normalized = item.text.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\\s+/).sort().join(' ').substring(0, 100);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(item);
    }
  }
  return result;
}

findings.problems = deduplicate(findings.problems);
findings.solutions = deduplicate(findings.solutions);
findings.opportunities = deduplicate(findings.opportunities);

// Store findings in memory
console.log('Storing findings in memory...');
try {
  const problemsSummary = findings.problems.slice(0, 10).map(p => p.text).join('\\n- ');
  if (problemsSummary) {
    await callTool('remember', {
      skill: 'archaeology',
      title: 'Discovered Problems & Pain Points',
      body: 'Problems mentioned in archived documents and emails:\\n- ' + problemsSummary,
    });
  }

  const solutionsSummary = findings.solutions.slice(0, 10).map(s => s.text).join('\\n- ');
  if (solutionsSummary) {
    await callTool('remember', {
      skill: 'archaeology',
      title: 'Attempted Solutions & Approaches',
      body: 'Solutions and approaches from historical records:\\n- ' + solutionsSummary,
    });
  }

  const opportunitiesSummary = findings.opportunities.slice(0, 10).map(o => o.text).join('\\n- ');
  if (opportunitiesSummary) {
    await callTool('remember', {
      skill: 'archaeology',
      title: 'Identified Opportunities & Ideas',
      body: 'Opportunities and market ideas from deep scan:\\n- ' + opportunitiesSummary,
    });
  }
} catch (e) {
  console.log(\`Error storing findings in memory: \${e.message}\`);
}

return {
  timestamp: new Date().toISOString(),
  summary: {
    problemsFound: findings.problems.length,
    solutionsFound: findings.solutions.length,
    opportunitiesFound: findings.opportunities.length,
  },
  problems: findings.problems.slice(0, 20),
  solutions: findings.solutions.slice(0, 20),
  opportunities: findings.opportunities.slice(0, 20),
  stored: 'Findings have been saved to memory under skill:archaeology',
};
`;
