// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Project-page deploy: https://<owner>.github.io/eidan/
// When the repo lives at a different owner, override SITE/BASE via env
// in the GH Pages workflow rather than editing this file.
const site = process.env.DOCS_SITE_URL ?? "https://sielay.github.io";
const base = process.env.DOCS_SITE_BASE ?? "/eidan";

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: "eidan",
      description:
        "Self-hosted personal agent OS for builders. Own your cognitive infrastructure.",
      social: { github: "https://github.com/sielay/eidan" },
      editLink: {
        baseUrl: "https://github.com/sielay/eidan/edit/main/",
      },
      sidebar: [
        {
          label: "Operate",
          items: [
            { slug: "architecture" },
            { slug: "deployment" },
            { slug: "localhost" },
            { slug: "roadmap" },
          ],
        },
        {
          label: "Specs",
          collapsed: false,
          autogenerate: { directory: "specs" },
        },
      ],
    }),
  ],
});
