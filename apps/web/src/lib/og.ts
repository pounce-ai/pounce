/**
 * Build-time renderer for the 1200×630 social cards.
 *
 * Every page used to unfurl with the square 1254×1254 app icon while declaring
 * `summary_large_image`, so X and Slack letterboxed it into a thin strip; the
 * docs pages declared that card with no image at all and unfurled bare. This
 * draws the landing hero instead — the desktop window with the phone over its
 * corner — under whichever title belongs to the page being shared.
 *
 * Rendered by Takumi (`@takumi-rs/core`, a Rust rasteriser) rather than the
 * `astro-takumi` integration: that wrapper is GPL-3.0 in an MIT repo, scrapes
 * its copy back out of the built HTML with jsdom, and allows one template for
 * the whole site. Driving the renderer from an endpoint keeps the licence
 * clean, takes the copy straight from the content collections, and still works
 * under `astro dev`, which the integration's `astro:build:done` hook does not.
 *
 * The fonts are checked in next door rather than loaded from Google like the
 * rest of the site: nothing resolves a system font here, so a face that is not
 * registered simply does not draw — on a laptop or on CI alike.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Renderer } from "@takumi-rs/core";
import { container, image, text } from "@takumi-rs/helpers";

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Sampled from the app icon; the same tokens `brand.css` documents. */
const GROUND = "#fef1e3";
const SURFACE = "#fffaf3";
const INK = "#241a2e";
const INK_2 = "#5b4f66";
const BRAND = "#a060f0";
const BRAND_INK = "#7231cf";
const PINK = "#ff7a9c";
const ORANGE = "#fcab3f";

/**
 * Resolved against the working directory, not `import.meta.url`.
 *
 * This module is bundled into `dist/.prerender/chunks/` before the build runs
 * it, so `import.meta.url` points into the output directory and every one of
 * these reads misses. Astro, Alchemy's deploy and `astro dev` all run from the
 * package root, so that is the stable base — and `assetFile` fails loudly
 * naming the directory it looked in, because the alternative is a card that
 * renders with the text silently missing.
 */
async function assetFile(path: string) {
  const file = resolve(process.cwd(), path);
  try {
    return await readFile(file);
  } catch (cause) {
    throw new Error(
      `Social-card asset "${path}" was not found at ${file} (cwd: ${process.cwd()}). ` +
        `Run the build from apps/web.`,
      { cause },
    );
  }
}

const FONTS = [
  { name: "Fraunces", weight: 700, file: "src/assets/fonts/Fraunces-Bold.woff2" },
  { name: "Jakarta", weight: 500, file: "src/assets/fonts/PlusJakartaSans-Medium.woff2" },
  { name: "Jakarta", weight: 800, file: "src/assets/fonts/PlusJakartaSans-ExtraBold.woff2" },
  { name: "Mono", weight: 600, file: "src/assets/fonts/JetBrainsMono-SemiBold.woff2" },
] as const;

/**
 * The two product shots and the icon, inlined as data URIs. Takumi will fetch a
 * remote `src` itself, but the card must render identically whether or not the
 * machine running the build can reach the deployed site.
 */
const IMAGES = {
  icon: "public/assets/icon.png",
  desktop: "public/assets/app-desktop-light.png",
  phone: "public/assets/app-session-light.png",
} as const;

/**
 * One renderer for the whole build. Registering four faces and decoding three
 * PNGs per card would repeat that work twenty times; Takumi caches decoded
 * images internally, so the shots are decoded once and drawn from cache.
 */
let ready: Promise<{ renderer: Renderer; src: Record<keyof typeof IMAGES, string> }> | undefined;

async function boot() {
  const renderer = new Renderer();
  await Promise.all(
    FONTS.map(async (font) =>
      renderer.registerFont({
        name: font.name,
        weight: font.weight,
        style: "normal",
        data: await assetFile(font.file),
      }),
    ),
  );

  const entries = await Promise.all(
    Object.entries(IMAGES).map(async ([key, file]) => {
      const bytes = await assetFile(file);
      return [key, `data:image/png;base64,${bytes.toString("base64")}`] as const;
    }),
  );

  return {
    renderer,
    src: Object.fromEntries(entries) as Record<keyof typeof IMAGES, string>,
  };
}

/**
 * Trim on a word boundary. Takumi has `lineClamp`, but clamping in the layout
 * means a long docs title silently loses its tail mid-word; cutting here keeps
 * the ellipsis honest and the block's height predictable.
 */
function clamp(value: string, max: number) {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A type alias rather than an interface on purpose: Astro's `getStaticPaths`
 * requires `props` to satisfy an index signature, which an interface never
 * does and an alias does.
 */
export type OgCard = {
  /** Small mono line above the title — the section, e.g. `Docs`. */
  eyebrow: string;
  title: string;
  description: string;
};

export async function renderOgImage({ eyebrow, title, description }: OgCard): Promise<Buffer> {
  ready ??= boot();
  const { renderer, src } = await ready;

  const heading = clamp(title, 64);
  const body = clamp(description, 128);
  // Fraunces is a display face and the copy column is 520px wide: the long docs
  // titles have to step down a size or two, or they run to five lines and shove
  // the description off the bottom of the card.
  const titleSize = heading.length > 46 ? 44 : heading.length > 26 ? 52 : 60;

  const card = container({
    style: {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      position: "relative",
      display: "flex",
      backgroundColor: GROUND,
      // Warms the top-left behind the wordmark, so the card is not a flat block
      // of cream in a feed full of flat blocks of white.
      backgroundImage: `radial-gradient(1100px 680px at 6% -20%, ${SURFACE} 0%, rgba(255, 250, 243, 0) 60%)`,
    },
    children: [
      // Left accent bar, in the icon's three colours.
      container({
        style: {
          position: "absolute",
          left: 0,
          top: 0,
          width: 14,
          height: OG_HEIGHT,
          backgroundImage: `linear-gradient(180deg, ${BRAND} 0%, ${PINK} 60%, ${ORANGE} 100%)`,
        },
      }),

      // ------------------------------------------------------------ the art
      // Bled off the right edge on purpose: a hero that fits entirely inside
      // the frame reads as a screenshot of a page, not as the product.
      container({
        style: { position: "absolute", left: 690, top: 132, width: 560, height: 349 },
        children: [
          image({
            src: src.desktop,
            width: 560,
            height: 349,
            style: {
              borderRadius: 14,
              boxShadow: "0 26px 60px rgba(36, 26, 46, 0.22)",
            },
          }),
          image({
            src: src.phone,
            width: 138,
            height: 300,
            style: {
              position: "absolute",
              left: -46,
              top: 78,
              borderRadius: 20,
              boxShadow: "0 22px 44px rgba(36, 26, 46, 0.28)",
            },
          }),
        ],
      }),

      // ----------------------------------------------------------- the copy
      container({
        style: {
          position: "absolute",
          left: 72,
          top: 64,
          // Stops ~50px short of the phone's left edge. Wider than this and a
          // long description's last line runs under the artwork.
          width: 520,
          height: OG_HEIGHT - 128,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        },
        children: [
          container({
            style: { display: "flex", alignItems: "center", gap: 18 },
            children: [
              image({ src: src.icon, width: 64, height: 64, style: { borderRadius: 16 } }),
              text(eyebrow.toUpperCase(), {
                fontFamily: "Mono",
                fontWeight: 600,
                fontSize: 24,
                letterSpacing: "0.08em",
                color: BRAND_INK,
              }),
            ],
          }),
          container({
            style: { display: "flex", flexDirection: "column", gap: 20 },
            children: [
              text(heading, {
                fontFamily: "Fraunces",
                fontWeight: 700,
                fontSize: titleSize,
                lineHeight: 1.08,
                letterSpacing: "-0.026em",
                color: INK,
              }),
              text(body, {
                fontFamily: "Jakarta",
                fontWeight: 500,
                fontSize: 24,
                lineHeight: 1.42,
                color: INK_2,
              }),
            ],
          }),
          text("use-pounce.com", {
            fontFamily: "Jakarta",
            fontWeight: 800,
            fontSize: 26,
            color: INK,
          }),
        ],
      }),
    ],
  });

  return renderer.render(card, { width: OG_WIDTH, height: OG_HEIGHT, format: "png" });
}
