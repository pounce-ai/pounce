/**
 * The current download for each platform, resolved at build time.
 *
 * The site used to send every visitor to `/releases/latest` and let them work
 * it out. They couldn't: that page is whichever release was published last, its
 * assets are named inconsistently, and for a long stretch it was macOS-only — so
 * a Windows visitor who clicked "Get it" landed on a page with a .dmg, a bridge
 * zip, and nothing they could run. Anyone who didn't already know the npx
 * command left with nothing.
 *
 * So the download links are resolved here instead, from the release API, and
 * rendered as real per-OS links with a version and a size next to them.
 *
 * Fetched at build time, never in the browser: no token ships and no visitor
 * makes a request. If the fetch fails (offline build, rate limit, GitHub down)
 * every link falls back to the releases page — a working link to a page the
 * visitor has to read beats a build that fails, and beats a dead direct link.
 */
const REPO = "pounce-ai/pounce";
const API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;

export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

export interface Download {
  /** Direct asset URL, or the releases page when nothing could be resolved. */
  url: string;
  /** Bytes, when known — omitted for the fallback link. */
  size?: number;
  /** True when this is a real asset rather than the fallback. */
  resolved: boolean;
}

export interface Downloads {
  /** e.g. "1.5.1", or null when unresolved. */
  version: string | null;
  macos: Download;
  windows: Download;
  linuxDeb: Download;
  linuxDebArm: Download;
  linuxTar: Download;
  linuxTarArm: Download;
  bridge: Download;
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
}

const fallback = (): Download => ({ url: RELEASES_PAGE, resolved: false });

/**
 * Asset name patterns, matching both the current versioned names
 * (`Pounce-1.5.1-Linux-x64.deb`) and the versionless ones used before releases
 * were unified. The older names still resolve so the site keeps working against
 * releases published before the change.
 */
const PATTERNS = {
  macos: /^Pounce\.dmg$/,
  // The zip, never the `Pounce-Setup-Windows.exe` sitting beside it on older
  // releases: that .exe is a ~400KB launcher whose app payload lives in the
  // `.installer` folder it was unzipped from, so on its own it installs
  // nothing. `stable-win-x64-Pounce-Setup.zip` is the same bytes under the
  // update channel's naming and is the only complete Windows download on
  // releases published before that was fixed — worth matching, because the
  // alternative for a Windows visitor is no working link at all.
  windows: /^(?:Pounce-(?:Setup-Windows|[\d.]+-Windows-x64)|stable-win-x64-Pounce-Setup)\.zip$/,
  linuxDeb: /^Pounce-(?:[\d.]+-)?Linux-x64\.deb$/,
  linuxDebArm: /^Pounce-(?:[\d.]+-)?Linux-arm64\.deb$/,
  linuxTar: /^Pounce-(?:Setup-Linux|[\d.]+-Linux)-x64\.tar\.gz$/,
  linuxTarArm: /^Pounce-(?:Setup-Linux|[\d.]+-Linux)-arm64\.tar\.gz$/,
  bridge: /^pounce-bridge\.zip$/,
} as const;

export async function fetchDownloads(): Promise<Downloads> {
  const empty: Downloads = {
    version: null,
    macos: fallback(),
    windows: fallback(),
    linuxDeb: fallback(),
    linuxDebArm: fallback(),
    linuxTar: fallback(),
    linuxTarArm: fallback(),
    bridge: fallback(),
  };

  try {
    const res = await fetch(API, {
      headers: {
        accept: "application/vnd.github+json",
        // Lifts the anonymous rate limit on CI, where many builds share an IP.
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return empty;

    const releases = ((await res.json()) as GhRelease[]).filter((r) => {
      const tag = r.tag_name ?? "";
      // Unified `v*` releases, plus the legacy `desktop-v*` ones that are still
      // where the Mac app and the headless bridge live until the first unified
      // release ships.
      return !r.draft && !r.prerelease && (/^v\d/.test(tag) || tag.startsWith("desktop-v"));
    });
    if (releases.length === 0) return empty;

    // Newest first, as the API returns them. Each platform takes the newest
    // release that actually carries its asset, rather than assuming one release
    // has them all — during the changeover it doesn't, and a visitor on the odd
    // platform out would otherwise get the fallback while everyone else got a
    // direct link.
    //
    // `requireAppcast` is not optional decoration. Pre-unification `v*`
    // releases carry a file called `Pounce.dmg` that is the Electrobun build
    // feeding the auto-updater, NOT the Mac app — and being newer, it wins a
    // name-only match. Linking it would hand Mac visitors the wrong
    // application. Only releases carrying the real app publish the Sparkle feed
    // beside it, so appcast.xml is the discriminator.
    const pick = (pattern: RegExp, requireAppcast = false): Download => {
      for (const r of releases) {
        const assets = r.assets ?? [];
        if (requireAppcast && !assets.some((a) => a.name === "appcast.xml")) continue;
        const asset = assets.find((a) => pattern.test(a.name));
        if (asset) return { url: asset.browser_download_url, size: asset.size, resolved: true };
      }
      return fallback();
    };

    // The version shown to visitors is the newest unified release — never a
    // legacy `desktop-v*`, whose 1.0.x numbering would read as older than the
    // app it ships.
    const unified = releases.find((r) => /^v\d/.test(r.tag_name ?? ""));

    const resolved: Downloads = {
      version: (unified?.tag_name ?? "").replace(/^v/, "") || null,
      macos: pick(PATTERNS.macos, true),
      windows: pick(PATTERNS.windows),
      linuxDeb: pick(PATTERNS.linuxDeb),
      linuxDebArm: pick(PATTERNS.linuxDebArm),
      linuxTar: pick(PATTERNS.linuxTar),
      linuxTarArm: pick(PATTERNS.linuxTarArm),
      bridge: pick(PATTERNS.bridge),
    };
    return resolved;
  } catch {
    return empty;
  }
}

/** "42 MB" — one decimal under 100MB, where the difference is worth seeing. */
export function formatSize(bytes?: number): string | null {
  if (!bytes) return null;
  const mb = bytes / 1e6;
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}
