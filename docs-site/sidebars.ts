// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// Hand-authored sidebar mirroring the planned IA. Only pages that exist are listed; the later
// sections (Guides, Bundles, Reference, Developer guide) get added as their pages land — a feature
// PR adds its doc page here. See docs-site/README.md.
const sidebars: SidebarsConfig = {
  docs: [
    { type: 'doc', id: 'intro', label: 'What is eidan?' },
    { type: 'doc', id: 'use-cases', label: 'Use cases' },
    {
      type: 'category',
      label: 'Getting started',
      items: ['getting-started'],
    },
    {
      type: 'category',
      label: 'Concepts',
      items: ['concepts'],
    },
  ],
};

export default sidebars;
