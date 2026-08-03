// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://use-pounce.com",
  // Emit `privacy.html` instead of `privacy/index.html` — the Play Console and
  // App Store metadata point at https://use-pounce.com/privacy.html, so the
  // old flat-file URLs must keep resolving after the GitHub Pages cutover.
  build: { format: "file" },
  integrations: [
    starlight({
      title: "Pounce Docs",
      description:
        "Docs for Pounce — control Claude Code, Codex, Cursor & opencode from your phone.",
      favicon: "/assets/favicon.png",
      logo: { src: "./src/assets/icon.png", alt: "Pounce" },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/pounce-ai/pounce" }],
      customCss: ["./src/styles/starlight.css"],
      sidebar: [
        {
          label: "Start here",
          items: ["docs", "docs/getting-started", "docs/install"],
        },
        {
          label: "Using Pounce",
          items: ["docs/agents", "docs/remote-access", "docs/desktop", "docs/cli", "docs/mcp"],
        },
        {
          label: "Help",
          items: ["docs/faq", "docs/troubleshooting"],
        },
      ],
      editLink: {
        baseUrl: "https://github.com/pounce-ai/pounce/edit/main/apps/web/",
      },
    }),
  ],
});
