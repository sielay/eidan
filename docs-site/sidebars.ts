// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

// Hand-authored sidebar mirroring the IA. Only pages that exist are listed; more land as they're
// written — a feature PR adds its doc page here. See docs-site/README.md.
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
    {
      type: 'category',
      label: 'Bundles',
      link: { type: 'doc', id: 'bundles' },
      items: ['bundles/sage', 'bundles/charles', 'bundles/charlotte'],
    },
    {
      type: 'category',
      label: 'Guides',
      items: [
        'guides/talk-to-eidan',
        'guides/capture-with-the-journal',
        'guides/build-an-agent',
        'guides/connect-your-accounts',
        'guides/delegate-to-sage',
        'guides/deploy',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: ['reference/plugins', 'reference/interop', 'reference/configuration'],
    },
    {
      type: 'category',
      label: 'Developer guide',
      items: ['develop/write-a-plugin'],
    },
  ],
};

export default sidebars;
