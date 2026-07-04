// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';

// eidan documentation site. Docs live at the site root (routeBasePath '/'), so `intro` is the home.
// Search is fully local/offline (@easyops-cn/docusaurus-search-local) so it works on GitHub Pages
// and Vercel with no external service. Deploys to docs.eidan.dev.
const config: Config = {
  title: 'eidan',
  tagline: 'A personal agent that remembers your life.',
  favicon: 'img/favicon.png',

  url: 'https://docs.eidan.dev',
  baseUrl: '/',

  organizationName: 'sielay',
  projectName: 'eidan',

  onBrokenLinks: 'throw',
  markdown: { hooks: { onBrokenMarkdownLinks: 'warn' } },

  i18n: { defaultLocale: 'en', locales: ['en'] },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/sielay/eidan/tree/main/docs-site/',
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        indexBlog: false,
        docsRouteBasePath: '/',
        highlightSearchTermsOnTargetPage: true,
      },
    ],
  ],

  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'eidan',
      items: [
        { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs' },
        { to: '/use-cases', label: 'Use cases', position: 'left' },
        { href: 'https://www.eidan.dev', label: 'eidan.dev', position: 'right' },
        { href: 'https://github.com/sielay/eidan', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Get started', to: '/getting-started' },
            { label: 'Concepts', to: '/concepts' },
            { label: 'Use cases', to: '/use-cases' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'eidan.dev', href: 'https://www.eidan.dev' },
            { label: 'GitHub', href: 'https://github.com/sielay/eidan' },
          ],
        },
      ],
      copyright: 'eidan — free & open source (AGPL-3.0-or-later).',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'sql'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
