#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bootstrap script to promote the three archaeology procedures into the knowledge graph.
 * Run this once after configuring Drive + Mail tools.
 *
 * Usage:
 *   node setup-archaeology.js [user-id]
 *
 * Example:
 *   node setup-archaeology.js 00000000-0000-0000-0000-000000000000
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROCEDURES = [
  {
    name: 'drive_deep_scan',
    description: 'Recursively scan Google Drive, extract files by type, surface patterns and opportunities',
  },
  {
    name: 'mail_thread_archaeology',
    description: 'Analyze email history, extract decision patterns, identify customer signals and seasonal trends',
  },
  {
    name: 'idea_extraction_pipeline',
    description: 'Read discovered Drive and mail content, extract ideas and opportunities, deduplicate and store findings',
  },
];

async function loadProcedures() {
  const archaeologyPath = path.join(__dirname, 'src', 'archaeology-procedures.ts');
  const source = await fs.readFile(archaeologyPath, 'utf-8');

  const procedures = {};
  for (const proc of PROCEDURES) {
    const exportName = proc.name.replace(/-/g, '_');
    const camelCase = proc.name
      .split(/_/)
      .map((w, i) => i === 0 ? w : w[0].toUpperCase() + w.slice(1))
      .join('');

    // Extract the procedure source from the TypeScript file
    const regex = new RegExp(`export const ${camelCase} = \\`([\\s\\S]*?)\\`;`, 'm');
    const match = source.match(regex);

    if (match) {
      // Extract the content between backticks (remove outer backticks and whitespace)
      procedures[proc.name] = match[1].trim();
    } else {
      console.error(`❌ Could not find procedure source for ${proc.name}`);
      process.exit(1);
    }
  }

  return procedures;
}

async function main() {
  const userId = process.argv[2];

  if (!userId) {
    console.log('\n⚠️  Usage: node setup-archaeology.js <user-id>');
    console.log('\nThis script promotes the archaeology procedures into your knowledge graph.');
    console.log('\nTo find your user ID:');
    console.log('  - Run eidan, ask the agent about your user ID');
    console.log('  - Or query: SELECT id FROM eidan.users LIMIT 1;');
    console.log('\nExample:');
    console.log('  node setup-archaeology.js 550e8400-e29b-41d4-a716-446655440000\n');
    process.exit(1);
  }

  console.log(`\n📦 Loading archaeology procedures...`);
  const procedures = await loadProcedures();

  console.log(`\n✅ Loaded ${PROCEDURES.length} procedures:\n`);
  for (const proc of PROCEDURES) {
    const source = procedures[proc.name];
    const lines = source.split('\n').length;
    console.log(`  • ${proc.name} (${lines} lines)`);
    console.log(`    ${proc.description}\n`);
  }

  console.log(`\nTo promote these procedures, run the following in the chat interface:\n`);
  console.log(`---\n`);

  for (const proc of PROCEDURES) {
    const source = procedures[proc.name];
    const escaped = source
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');

    console.log(`> Promote the ${proc.name} procedure.`);
    console.log(`\nAgent will prompt for approval, then save it to the knowledge graph.\n`);
    console.log(`---\n`);
  }

  console.log(`\nAlternatively, to add manually to the database:\n`);
  console.log(`\`\`\`sql`);
  console.log(`INSERT INTO eidan.knowledge (user_id, skill, title, body) VALUES`);

  for (let i = 0; i < PROCEDURES.length; i++) {
    const proc = PROCEDURES[i];
    const source = procedures[proc.name];
    const comma = i < PROCEDURES.length - 1 ? ',' : ';';
    console.log(`  ('${userId}', 'procedure', '${proc.name}', '${source.replace(/'/g, "''")}')${comma}`);
  }

  console.log(`\`\`\``);
  console.log(`\n`);

  console.log(`\n📋 After promoting, ensure matbot.yaml has:\n`);
  console.log(`\`\`\`yaml`);
  console.log(`EIDAN_PROCEDURE_TOOLS: gdrive_search,gdrive_read_file,imap_search,imap_read_message,remember,recall`);
  console.log(`\`\`\``);
  console.log(`\nThen you can invoke them with:`);
  console.log(`\`\`\`javascript`);
  console.log(`await callTool('procedures', { action: 'run_saved', name: 'drive_deep_scan' })`);
  console.log(`\`\`\`\n`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
