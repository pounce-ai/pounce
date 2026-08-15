/**
 * schema.org JSON-LD for the hand-built pages.
 *
 * The site had no structured data at all, so search engines had to infer what
 * Pounce is from prose. These three nodes state it outright: who publishes it,
 * what the site is, and that the thing being described is a free developer
 * application with iOS and macOS builds.
 *
 * One `@graph` rather than three separate script tags, so the nodes can
 * reference each other by `@id` instead of repeating themselves.
 */
export const SITE_URL = "https://use-pounce.com";

const ORG_ID = `${SITE_URL}/#organization`;
const SITE_ID = `${SITE_URL}/#website`;
const APP_ID = `${SITE_URL}/#app`;

export function siteGraph() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORG_ID,
        name: "Pounce",
        url: `${SITE_URL}/`,
        logo: `${SITE_URL}/assets/icon.png`,
        sameAs: ["https://github.com/pounce-ai/pounce", "https://discord.gg/xK5MQ8KzQH"],
      },
      {
        "@type": "WebSite",
        "@id": SITE_ID,
        name: "Pounce",
        url: `${SITE_URL}/`,
        publisher: { "@id": ORG_ID },
        inLanguage: "en",
      },
      {
        "@type": "SoftwareApplication",
        "@id": APP_ID,
        name: "Pounce",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "iOS, Android, macOS, Windows, Linux",
        url: `${SITE_URL}/`,
        downloadUrl: "https://apps.apple.com/app/id6779601425",
        publisher: { "@id": ORG_ID },
        license: "https://opensource.org/licenses/MIT",
        description:
          "Control the coding agents running on your own machines — Claude Code, Codex, Cursor and opencode — from your desk and your phone.",
        // Pounce is free and MIT licensed; stating the price explicitly is what
        // lets a result show "Free" rather than nothing.
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
    ],
  };
}

/**
 * Breadcrumbs for anything below the root. Search results show the trail in
 * place of a bare URL, which matters most for the docs, where the URL alone
 * ("/docs/remote-access") is the only context a reader gets.
 */
export function breadcrumbs(trail: Array<{ name: string; path: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: new URL(crumb.path, `${SITE_URL}/`).href,
    })),
  };
}
