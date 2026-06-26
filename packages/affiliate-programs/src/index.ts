// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { Db } from './db.js';
import { AffiliateService } from './affiliate-service.js';
import {
  listAffiliatePrograms,
  generateAffiliateLink,
  injectAffiliateLinks,
  queryAffiliateLinks,
  getAffiliatePerformance,
} from './tools.js';

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    AffiliateService?: AffiliateService;
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description: 'Affiliate program automation: discover programs, generate tracked affiliate links, inject them safely into content, and track performance.',
  },
  async setup(services: MatbotServices) {
    const url = process.env['EIDAN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
    if (!url) throw new Error('EIDAN_DATABASE_URL (or DATABASE_URL) must be set for @eidandev/affiliate-programs');

    const service = new AffiliateService(new Db(url));
    await services.register('AffiliateService', service);

    services.tools.register(listAffiliatePrograms(service));
    services.tools.register(generateAffiliateLink(service));
    services.tools.register(injectAffiliateLinks(service));
    services.tools.register(queryAffiliateLinks(service));
    services.tools.register(getAffiliatePerformance(service));
  },
};
