// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MatbotPluginSpec, MatbotServices } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';
import { makeStripeTools } from './tools.js';

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
  }
}

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  manifest: {
    description:
      'Stripe Finance: read-only balance, charges/transactions, invoices, revenue analytics, and a revenue timeseries (stripe_balance, stripe_transactions, stripe_invoices, stripe_analytics, stripe_revenue_timeseries) via the Stripe API with Bearer token auth and matbot vault secrets.',
  },
  async setup(services: MatbotServices) {
    const tools = makeStripeTools();
    for (const t of tools) services.tools.register(t);

    services.EidanSecrets?.declareSection({
      plugin: 'finance-stripe',
      title: 'Stripe Finance',
      fields: [
        {
          name: 'STRIPE_API_KEY',
          label: 'Stripe API key',
          secret: true,
          required: true,
          help: 'A restricted (read-only) key from https://dashboard.stripe.com/apikeys — grant read access to Charges, Invoices, and Balance. A full secret key works but a restricted read key is safer.',
        },
      ],
    });

    console.log('[finance-stripe] plugin loaded: stripe_balance, stripe_transactions, stripe_invoices, stripe_analytics, stripe_revenue_timeseries');
  },
};
