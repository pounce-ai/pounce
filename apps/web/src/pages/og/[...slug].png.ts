/**
 * Renders one social card per page at build time.
 *
 * An endpoint rather than a post-build hook: the same route answers under
 * `astro dev`, so a card can be opened at `/og/index.png` and iterated on
 * without a full build, and Astro emits it into `dist/` as a plain static file
 * that Cloudflare serves like any other asset.
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { type OgCard, renderOgImage } from "../../lib/og";
import { allOgCards } from "../../lib/ogPages";

export const getStaticPaths: GetStaticPaths = async () =>
  (await allOgCards()).map(({ slug, card }) => ({ params: { slug }, props: card }));

export const GET: APIRoute = async ({ props }) => {
  const png = await renderOgImage(props as OgCard);

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      // Cards are content-addressed by page, not by revision, so a scraper
      // that cached one should recheck occasionally rather than pin it for a
      // year — the copy changes when the page's title does.
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
};
