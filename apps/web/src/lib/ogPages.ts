/**
 * Which social card belongs to which page.
 *
 * The endpoint that renders the images and the `<head>` that points at them
 * both read this, so a card can never be emitted under a path nothing links to
 * — or, worse, linked from a page that never generated one. Twitter and Slack
 * both drop an `og:image` that 404s and fall back to no card at all, and that
 * failure is invisible from the site itself.
 */
import { getCollection } from "astro:content";
import type { OgCard } from "./og";

/** The card every page falls back to: the landing hero. */
export const DEFAULT_OG_SLUG = "index";

export function ogImagePath(slug: string) {
  return `/og/${slug}.png`;
}

/**
 * The hand-built pages. Their copy lives here rather than beside each
 * `<BaseHead>` call so the card and the `og:title` cannot drift apart — the
 * card is what a reader sees first, and a card that disagrees with the title
 * under it looks like the wrong link was pasted.
 */
export const MARKETING_CARDS: Record<string, OgCard> = {
  index: {
    eyebrow: "Pounce",
    title: "Spreading love among your coding agents.",
    // Kept under the card's clamp so the hero — the one card most people see —
    // ends on a full stop rather than an ellipsis.
    description:
      "Scoped, expiring, read-only access grants. Your cross-agent history over MCP. Tokens, spend, plan limits and worktree disk.",
  },
  "how-it-works": {
    eyebrow: "How it works",
    title: "A remote for the agents you already run.",
    description:
      "Install Pounce on your computer, scan one QR code with your phone, and you're paired. No account, and no cloud in the middle.",
  },
  changelog: {
    eyebrow: "Changelog",
    title: "What's new in Pounce",
    description:
      "Releases across the iPhone and Android apps, the desktop app, the bridge, and the use-pounce CLI.",
  },
  privacy: {
    eyebrow: "Privacy",
    title: "Your work stays on your own devices.",
    description:
      "No account, and no Pounce server that your code or your conversations pass through.",
  },
};

/**
 * The card for a page that may or may not have one, falling back to the hero.
 *
 * Checked against what `allOgCards` actually emits rather than against the
 * slug looking plausible: Starlight's 404 route arrives here with a
 * synthesised entry whose id is `404`, which is truthy and reads exactly like
 * a real page, and pointing `og:image` at a card the build never rendered is
 * the one failure the site itself cannot show you.
 */
export async function resolveOgSlug(slug: string | undefined) {
  if (!slug) return DEFAULT_OG_SLUG;
  const cards = await allOgCards();
  return cards.some((card) => card.slug === slug) ? slug : DEFAULT_OG_SLUG;
}

/**
 * Every card the build should emit: the marketing pages above, plus one per
 * docs page taken from its own frontmatter.
 */
export async function allOgCards(): Promise<Array<{ slug: string; card: OgCard }>> {
  const docs = await getCollection("docs");

  return [
    ...Object.entries(MARKETING_CARDS).map(([slug, card]) => ({ slug, card })),
    ...docs.map((entry) => ({
      slug: entry.id,
      card: {
        eyebrow: "Docs",
        title: entry.data.title,
        // Starlight's schema makes `description` optional. Every page has one
        // today, but a new page landing without one should still get a card.
        description:
          entry.data.description ??
          "Control the coding agents running on your own machines, from your desk and your phone.",
      },
    })),
  ];
}
