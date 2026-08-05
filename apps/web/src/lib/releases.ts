/**
 * GitHub releases, folded into the changelog at build time.
 *
 * Every shipped artifact already announces itself on GitHub — the desktop
 * workflow publishes `desktop-v*` with its own notes, and the tunnel does the
 * same. Re-typing those into a hand-written entry is how a changelog goes
 * stale: the release happens, the site doesn't hear about it, and the last
 * visible entry is weeks behind what people are actually running.
 *
 * So the page shows both. Hand-written entries stay the editorial voice for
 * things worth explaining; releases fill in everything else automatically, and a
 * hand-written entry always wins where both describe the same version.
 *
 * Fetched at build time, never in the browser: no API key ships, no request is
 * made by a visitor, and the built HTML is static. A failure here (offline
 * build, rate limit, GitHub down) returns nothing and leaves the hand-written
 * entries alone — a changelog missing its automatic half is a far better
 * outcome than a site that won't build.
 */
import { marked } from "marked";

const REPO = "pounce-ai/pounce";
const API = `https://api.github.com/repos/${REPO}/releases?per_page=50`;

/**
 * How many releases to surface, newest first.
 *
 * Left uncapped this fills the page with a decade of point releases whose notes
 * are near-identical boilerplate — ten "Pounce Desktop 1.0.2x" entries in a row
 * push the things actually worth reading off the screen. The cap keeps the feed
 * current without letting it become the whole page; anything older is one click
 * away on GitHub.
 */
const MAX_RELEASES = 12;

/** Tag prefix → which part of Pounce it is. Anything else is skipped: an
 *  unrecognised tag is more likely a mistake than a thing to publish. */
const COMPONENT_BY_PREFIX: Record<string, string> = {
  desktop: "desktop",
  tunnel: "tunnel",
  bridge: "bridge",
  ios: "ios",
  android: "android",
  cli: "cli",
};

export interface ReleaseEntry {
  id: string;
  title: string;
  date: Date;
  component: string;
  version?: string;
  link: string;
  html: string;
}

/** `desktop-v1.0.30` → { component: "desktop", version: "1.0.30" } */
function parseTag(tag: string): { component: string; version?: string } | null {
  const m = tag.match(/^([a-z]+)-v?(.+)$/i);
  if (!m) return null;
  const component = COMPONENT_BY_PREFIX[m[1].toLowerCase()];
  return component ? { component, version: m[2] } : null;
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

export async function fetchReleases(): Promise<ReleaseEntry[]> {
  try {
    const res = await fetch(API, {
      headers: {
        accept: "application/vnd.github+json",
        // Lifts the anonymous rate limit on CI, where many builds share an IP.
        // Optional by design: a local build without it still works.
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const releases = (await res.json()) as GhRelease[];

    return releases
      .filter((r) => !r.draft && !r.prerelease && r.published_at)
      .sort((a, b) => Date.parse(b.published_at as string) - Date.parse(a.published_at as string))
      .slice(0, MAX_RELEASES)
      .flatMap((r) => {
        const parsed = parseTag(r.tag_name);
        if (!parsed) return [];
        return [
          {
            id: r.tag_name,
            title: r.name?.trim() || r.tag_name,
            date: new Date(r.published_at as string),
            component: parsed.component,
            version: parsed.version,
            link: r.html_url,
            // Release notes are authored by repo maintainers, the same trust
            // level as this site's own source, so the markdown is rendered as
            // written rather than stripped down.
            html: r.body ? (marked.parse(r.body, { async: false }) as string) : "",
          },
        ];
      });
  } catch {
    return [];
  }
}

/** Key identifying the thing a changelog entry is about, so a hand-written
 *  entry and the release it describes are recognised as one item. */
export const releaseKey = (component: string, version?: string) => `${component}:${version ?? ""}`;
