// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { AffiliateDb } from './db.js';
import { buildAffiliateTools } from './tools.js';
import { discoverPrograms } from './discovery.js';

interface SecretField {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
}

interface SecretSection {
  plugin: string;
  title: string;
  fields: SecretField[];
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    EidanSecrets?: { declareSection(section: SecretSection): void };
    AffiliateDiscovery?: { discoverPrograms(userId: string): Promise<any> };
    Vault?: {
      resolve(ref: string): Promise<string | undefined>;
    };
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Affiliate program discovery + multi-program credential management: 25+ book/tech affiliates with vault storage, smart link generation, and context-aware program suggestions.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/affiliates');

    const db = new AffiliateDb(url);

    for (const tool of buildAffiliateTools(db, services)) {
      services.tools.register(tool);
    }

    services.EidanSecrets?.declareSection({
      plugin: 'affiliates',
      title: 'Affiliate Programs',
      fields: [
        {
          name: 'AMAZON_AFFILIATE_ID',
          label: 'Amazon Associates tag',
          secret: true,
          required: false,
          help: 'Your Amazon Associates affiliate tag (e.g., your-tag-20)',
        },
        {
          name: 'KOBO_AFFILIATE_ID',
          label: 'Kobo Affiliate ID',
          secret: true,
          required: false,
          help: 'Your Kobo affiliate ID',
        },
        {
          name: 'NORDVPN_AFFILIATE_ID',
          label: 'NordVPN Affiliate ID',
          secret: true,
          required: false,
          help: 'Your NordVPN partner affiliate ID',
        },
        {
          name: 'SKILLSHARE_AFFILIATE_ID',
          label: 'Skillshare Affiliate ID',
          secret: true,
          required: false,
          help: 'Your Skillshare affiliate ID',
        },
        {
          name: 'UDEMY_AFFILIATE_ID',
          label: 'Udemy Affiliate ID',
          secret: true,
          required: false,
          help: 'Your Udemy affiliate ID',
        },
      ],
    });

    services.AffiliateDiscovery = {
      discoverPrograms: async (userId: string) => {
        return discoverPrograms(db, userId);
      },
    };

    console.log('[affiliates] plugin loaded: affiliate_programs_list, affiliate_program_add, affiliate_credential_store, affiliate_link_generate, affiliate_link_suggest');
  },
};
