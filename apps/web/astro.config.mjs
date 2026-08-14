// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { THEME_BOOTSTRAP } from "./src/lib/themeBootstrap";

export default defineConfig({
  site: "https://use-pounce.com",
  // Emit `privacy.html` instead of `privacy/index.html` — the Play Console and
  // App Store metadata point at https://use-pounce.com/privacy.html, so the
  // old flat-file URLs must keep resolving after the GitHub Pages cutover.
  build: { format: "file" },
  /**
   * Astro is a multi-page app: without this, every link is a cold document
   * request made only when you click, which is why the docs felt like a full
   * reload rather than a nav.
   *
   * Prefetching on hover/touch-start means the HTML is usually already in the
   * cache by the time the click lands, so the navigation is near-instant while
   * each page stays a real document — no client router, no hydration, and none
   * of the state-restoration problems those bring with Starlight's islands and
   * our pre-paint theme script.
   *
   * `hover` rather than `viewport`: the docs sidebar puts ~20 links on screen at
   * once, and prefetching all of them on sight would pull far more than anyone
   * reads.
   */
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  integrations: [
    starlight({
      /**
       * The docs run Starlight's ThemeProvider, which falls back to the OS when
       * nothing is stored: no stored value + a dark OS resolves to dark, while
       * the rest of the site now defaults to light. A visitor on a dark Mac
       * would get a light landing page and dark docs.
       *
       * Settling the stored value fixes it in either script order — if this runs
       * first, ThemeProvider reads "light" and agrees; if ThemeProvider already
       * ran and guessed dark, this corrects the attribute. It also paints the
       * ground before first paint, so navigating between docs pages does not
       * flash white in dark mode.
       */
      head: [{ tag: "script", content: THEME_BOOTSTRAP }],
      /**
       * No ClientRouter on the docs, deliberately.
       *
       * Starlight builds the Pagefind UI inside a `DOMContentLoaded` listener,
       * and that event fires once per document load — a view transition swap
       * never fires it again, so the search modal opened onto an empty box for
       * anyone who arrived by clicking a sidebar link. Starlight offers no hook
       * to re-run it, which is consistent with it shipping no view transition
       * support at all.
       *
       * Re-creating PagefindUI ourselves would mean duplicating Starlight's
       * translations, baseUrl and processResult wiring and keeping that copy in
       * step with a dependency's internals. Working search is worth more than a
       * softer page change, and prefetch already makes these navigations quick.
       * The hand-built pages, which own all their own scripts, keep the router.
       */
      title: "Pounce Docs",
      description:
        "Docs for Pounce — control Claude Code, Codex, Cursor & opencode from your phone.",
      favicon: "/assets/favicon.png",
      logo: { src: "./src/assets/icon.png", alt: "Pounce" },
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/pounce-ai/pounce" },
        { icon: "discord", label: "Discord", href: "https://discord.gg/xK5MQ8KzQH" },
      ],
      customCss: ["./src/styles/starlight.css"],
      sidebar: [
        {
          label: "Start here",
          items: ["docs", "docs/getting-started", "docs/install"],
        },
        {
          label: "Using Pounce",
          items: [
            "docs/spaces",
            "docs/changes",
            "docs/search",
            "docs/activity",
            "docs/context",
            "docs/agents",
            "docs/sharing",
            "docs/remote-access",
            "docs/desktop",
            "docs/cli",
            "docs/mcp",
          ],
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
