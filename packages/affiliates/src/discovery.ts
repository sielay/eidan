// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AffiliateDb } from './db.js';

export interface DiscoveryResult {
  program_name: string;
  provider: string;
  category: 'book' | 'content' | 'tech' | 'other';
  commission_rate: number | null;
  link_format: 'url' | 'api' | 'pixel';
  signup_url?: string;
  api_endpoint?: string;
  api_docs_url?: string;
  relevance_score: number;
  content_types?: string[];
}

const DISCOVERY_CATALOG: DiscoveryResult[] = [
  {
    program_name: 'Kobo Affiliates',
    provider: 'kobo',
    category: 'book',
    commission_rate: 15,
    link_format: 'url',
    signup_url: 'https://affiliates.kobo.com/',
    api_docs_url: 'https://affiliates.kobo.com/api-docs',
    relevance_score: 9.5,
    content_types: ['book', 'article', 'post'],
  },
  {
    program_name: 'Apple Books Affiliate',
    provider: 'apple_books',
    category: 'book',
    commission_rate: 5,
    link_format: 'url',
    signup_url: 'https://affiliate.apple.com/',
    relevance_score: 9,
    content_types: ['book', 'article'],
  },
  {
    program_name: 'Amazon Associates',
    provider: 'amazon',
    category: 'book',
    commission_rate: 8.5,
    link_format: 'url',
    signup_url: 'https://associates.amazon.com/',
    api_endpoint: 'https://api.amazon.com/associates',
    api_docs_url: 'https://affiliate-program.amazon.com/gp/advertising/api/docs/en/',
    relevance_score: 9.8,
    content_types: ['book', 'article', 'video'],
  },
  {
    program_name: 'Google Play Books',
    provider: 'google_play',
    category: 'book',
    commission_rate: 15,
    link_format: 'url',
    signup_url: 'https://play.google.com/books/promotion/partners/',
    relevance_score: 8.5,
    content_types: ['book'],
  },
  {
    program_name: 'Smashwords Affiliate',
    provider: 'smashwords',
    category: 'book',
    commission_rate: 50,
    link_format: 'url',
    signup_url: 'https://www.smashwords.com/about/affiliate',
    relevance_score: 8,
    content_types: ['book'],
  },
  {
    program_name: 'Wattpad',
    provider: 'wattpad',
    category: 'book',
    commission_rate: null,
    link_format: 'url',
    signup_url: 'https://www.wattpad.com/writers/rewards',
    relevance_score: 7.5,
    content_types: ['book', 'story'],
  },
  {
    program_name: 'BookBaby',
    provider: 'bookbaby',
    category: 'book',
    commission_rate: 10,
    link_format: 'url',
    signup_url: 'https://www.bookbaby.com/author-program/affiliate',
    relevance_score: 7,
    content_types: ['book'],
  },
  {
    program_name: 'IngramSpark',
    provider: 'ingramspark',
    category: 'book',
    commission_rate: 7,
    link_format: 'url',
    signup_url: 'https://www.ingramspark.com/affiliates',
    relevance_score: 7.5,
    content_types: ['book'],
  },
  {
    program_name: 'Scribd',
    provider: 'scribd',
    category: 'book',
    commission_rate: null,
    link_format: 'url',
    signup_url: 'https://www.scribd.com/creators/affiliate-program',
    relevance_score: 7,
    content_types: ['book', 'document'],
  },
  {
    program_name: 'Audible',
    provider: 'audible',
    category: 'book',
    commission_rate: 5,
    link_format: 'url',
    signup_url: 'https://affiliates.audible.com/',
    relevance_score: 8.5,
    content_types: ['book', 'audio', 'podcast'],
  },
  {
    program_name: 'NordVPN',
    provider: 'nordvpn',
    category: 'tech',
    commission_rate: 40,
    link_format: 'url',
    signup_url: 'https://affiliates.nordvpn.com/',
    api_endpoint: 'https://api.affiliates.nordvpn.com/v1/links',
    relevance_score: 9,
    content_types: ['video', 'article', 'post'],
  },
  {
    program_name: 'ExpressVPN',
    provider: 'expressvpn',
    category: 'tech',
    commission_rate: 40,
    link_format: 'url',
    signup_url: 'https://affiliates.expressvpn.com/',
    relevance_score: 8.5,
    content_types: ['video', 'article'],
  },
  {
    program_name: 'Surfshark',
    provider: 'surfshark',
    category: 'tech',
    commission_rate: 30,
    link_format: 'url',
    signup_url: 'https://surfshark.com/partners/affiliate-program',
    relevance_score: 8,
    content_types: ['video', 'article'],
  },
  {
    program_name: 'Fiverr',
    provider: 'fiverr',
    category: 'tech',
    commission_rate: 30,
    link_format: 'url',
    signup_url: 'https://affiliates.fiverr.com/',
    api_endpoint: 'https://api.fiverr.com/v2/affiliates',
    relevance_score: 8.5,
    content_types: ['article', 'video', 'post'],
  },
  {
    program_name: 'Upwork',
    provider: 'upwork',
    category: 'tech',
    commission_rate: 5,
    link_format: 'url',
    signup_url: 'https://www.upwork.com/affiliates',
    relevance_score: 7.5,
    content_types: ['article', 'post'],
  },
  {
    program_name: 'Skillshare',
    provider: 'skillshare',
    category: 'tech',
    commission_rate: 45,
    link_format: 'url',
    signup_url: 'https://www.skillshare.com/teach/affiliate-program',
    api_endpoint: 'https://api.skillshare.com/affiliates',
    relevance_score: 8.5,
    content_types: ['video', 'article', 'post'],
  },
  {
    program_name: 'Udemy',
    provider: 'udemy',
    category: 'tech',
    commission_rate: 35,
    link_format: 'url',
    signup_url: 'https://www.udemy.com/affiliate/',
    api_endpoint: 'https://api.udemy.com/v1/affiliate-links',
    relevance_score: 9,
    content_types: ['video', 'article', 'post'],
  },
  {
    program_name: 'Coursera',
    provider: 'coursera',
    category: 'tech',
    commission_rate: 45,
    link_format: 'url',
    signup_url: 'https://www.coursera.org/affiliate',
    relevance_score: 8.5,
    content_types: ['video', 'article'],
  },
  {
    program_name: 'GitHub Copilot',
    provider: 'github',
    category: 'tech',
    commission_rate: null,
    link_format: 'url',
    signup_url: 'https://github.com/copilot/referral',
    relevance_score: 8,
    content_types: ['article', 'post', 'video'],
  },
  {
    program_name: 'ChatGPT Plus',
    provider: 'openai',
    category: 'tech',
    commission_rate: null,
    link_format: 'url',
    signup_url: 'https://openai.com/partners',
    relevance_score: 7.5,
    content_types: ['article', 'post', 'video'],
  },
  {
    program_name: 'Notion',
    provider: 'notion',
    category: 'tech',
    commission_rate: 30,
    link_format: 'url',
    signup_url: 'https://www.notion.so/affiliates',
    relevance_score: 8,
    content_types: ['article', 'post', 'video'],
  },
  {
    program_name: 'Monday.com',
    provider: 'monday',
    category: 'tech',
    commission_rate: 25,
    link_format: 'url',
    signup_url: 'https://monday.com/affiliates',
    relevance_score: 7.5,
    content_types: ['article', 'post'],
  },
  {
    program_name: 'Zapier',
    provider: 'zapier',
    category: 'tech',
    commission_rate: 30,
    link_format: 'url',
    signup_url: 'https://zapier.com/partners/affiliate',
    relevance_score: 7.5,
    content_types: ['article', 'post', 'video'],
  },
  {
    program_name: 'Netlify',
    provider: 'netlify',
    category: 'tech',
    commission_rate: null,
    link_format: 'url',
    signup_url: 'https://www.netlify.com/affiliates/',
    relevance_score: 7,
    content_types: ['article', 'video'],
  },
  {
    program_name: 'Vercel',
    provider: 'vercel',
    category: 'tech',
    commission_rate: null,
    link_format: 'url',
    signup_url: 'https://vercel.com/referrals',
    relevance_score: 7,
    content_types: ['article', 'video'],
  },
  {
    program_name: 'AWS',
    provider: 'aws',
    category: 'tech',
    commission_rate: 5,
    link_format: 'url',
    signup_url: 'https://aws.amazon.com/partners/affiliates/',
    relevance_score: 8,
    content_types: ['article', 'video', 'post'],
  },
];

export async function discoverPrograms(db: AffiliateDb, userId: string): Promise<DiscoveryResult[]> {
  const existing = await db.listPrograms(userId);
  const existingProviders = new Set(existing.map((p) => p.provider));

  const newPrograms = DISCOVERY_CATALOG.filter((p) => !existingProviders.has(p.provider));

  if (newPrograms.length > 0) {
    for (const program of newPrograms) {
      await db.insertProgram(userId, {
        program_name: program.program_name,
        provider: program.provider,
        category: program.category,
        commission_rate: program.commission_rate,
        link_format: program.link_format,
        signup_url: program.signup_url,
        api_endpoint: program.api_endpoint,
        api_docs_url: program.api_docs_url,
        relevance_score: program.relevance_score,
        content_types: program.content_types,
        metadata: { discovered_at: new Date().toISOString() },
      });
    }

    await db.logDiscovery(userId, DISCOVERY_CATALOG.length, newPrograms.length, 'monthly_scan');
  }

  return newPrograms;
}
