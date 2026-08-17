/**
 * Which file `npx use-pounce configure` downloads, and from where.
 *
 * This is the one piece of CLI logic that can install the wrong application on
 * someone's machine, and it just changed shape: releases were unified from two
 * tag families (`desktop-v*` for the Mac app, `v*` for Windows/Linux) into one
 * `v<version>` release per version, and the installers gained the version in
 * their filenames. Both the old and new names have to keep resolving, because a
 * freshly published CLI still sees years of older releases on the API.
 *
 * The case worth guarding hardest is macOS. Pre-unification `v*` releases carry
 * a file literally called `Pounce.dmg` that is NOT the Mac app — it is the
 * Electrobun build that exists only to feed the auto-updater. Matching on the
 * name alone installs the wrong Pounce.
 */
import { describe, expect, it } from "vitest";
import { desktopOption, resolveAsset } from "./configure.mjs";

const mac = { platform: "darwin", arch: "arm64" };
const win = { platform: "win32", arch: "x64" };
const linux = { platform: "linux", arch: "x64" };

/** A release as the GitHub API returns it, trimmed to what resolveAsset reads. */
const release = (tag, names) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: names.map((name) => ({ name, browser_download_url: `https://example/${tag}/${name}` })),
});

/**
 * resolveAsset fetches from the network. Rather than reach for a mocking
 * framework, drive it through a stubbed global fetch — it makes exactly one
 * request and reads only the JSON body.
 */
async function resolveAgainst(releases, option) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(releases), { status: 200 });
  try {
    return await resolveAsset(option, "0.0.0-test");
  } finally {
    globalThis.fetch = original;
  }
}

const UNIFIED = release("v1.5.1", [
  "Pounce.dmg",
  "appcast.xml",
  "pounce-bridge.zip",
  "Pounce-1.5.1-Windows-x64.zip",
  "Pounce-1.5.1-Linux-x64.deb",
  "Pounce-1.5.1-Linux-x64.tar.gz",
]);

// How the releases page looked before unification: a Mac-only `desktop-v*`, and
// a `v*` whose `Pounce.dmg` is the updater's copy rather than the app — and
// whose `Pounce-Setup-Windows.exe` is a launcher with no payload.
const LEGACY_DESKTOP = release("desktop-v1.0.46", [
  "Pounce.dmg",
  "appcast.xml",
  "pounce-bridge.zip",
]);
const LEGACY_APP = release("v1.2.0", [
  "Pounce.dmg",
  "Pounce-Setup-Windows.exe",
  "stable-win-x64-Pounce-Setup.zip",
  "Pounce-Linux-x64.deb",
  "Pounce-Setup-Linux-x64.tar.gz",
]);

describe("desktopOption", () => {
  it("refuses platforms with no build, with a reason", () => {
    expect(desktopOption({ platform: "darwin", arch: "x64" })).toMatchObject({
      available: false,
      why: expect.stringContaining("Apple Silicon"),
    });
    expect(desktopOption({ platform: "linux", arch: "riscv64" }).available).toBe(false);
    expect(desktopOption({ platform: "sunos", arch: "x64" }).available).toBe(false);
  });

  it("won't offer a GUI app to a headless Linux box", () => {
    expect(desktopOption({ ...linux, headless: true })).toMatchObject({ available: false });
  });
});

describe("resolveAsset", () => {
  it("takes each platform's installer from the unified release", async () => {
    await expect(resolveAgainst([UNIFIED], desktopOption(mac))).resolves.toMatchObject({
      name: "Pounce.dmg",
      tag: "v1.5.1",
    });
    await expect(resolveAgainst([UNIFIED], desktopOption(win))).resolves.toMatchObject({
      name: "Pounce-1.5.1-Windows-x64.zip",
    });
    await expect(resolveAgainst([UNIFIED], desktopOption(linux))).resolves.toMatchObject({
      name: expect.stringMatching(/^Pounce-1\.5\.1-Linux-x64\.(deb|tar\.gz)$/),
    });
  });

  it("still resolves the old, versionless asset names", async () => {
    await expect(resolveAgainst([LEGACY_DESKTOP], desktopOption(mac))).resolves.toMatchObject({
      name: "Pounce.dmg",
      tag: "desktop-v1.0.46",
    });
    // .deb or tarball depending on whether the host running these tests has
    // dpkg — both legacy names must resolve, and which one is offered is the
    // host's business, not this test's.
    await expect(resolveAgainst([LEGACY_APP], desktopOption(linux))).resolves.toMatchObject({
      name: expect.stringMatching(/^Pounce-(?:Linux-x64\.deb|Setup-Linux-x64\.tar\.gz)$/),
    });
  });

  // `Pounce-Setup-Windows.exe` is a ~400KB launcher; its payload lives in the
  // `.installer` folder inside the zip it was wrongly unwrapped from. Choosing
  // it means downloading something that installs nothing.
  it("never hands Windows the payload-less launcher .exe", async () => {
    const found = await resolveAgainst([LEGACY_APP], desktopOption(win));
    expect(found.name).toBe("stable-win-x64-Pounce-Setup.zip");
    expect(desktopOption(win).kind).toBe("zip");

    const exeOnly = release("v1.2.0", ["Pounce-Setup-Windows.exe"]);
    await expect(resolveAgainst([exeOnly], desktopOption(win))).rejects.toThrow(/no download/);
  });

  // The regression this file exists for.
  it("never hands macOS the updater's Pounce.dmg from a legacy v* release", async () => {
    await expect(resolveAgainst([LEGACY_APP], desktopOption(mac))).rejects.toThrow(/no download/);

    // Newest first, exactly as the API returns them: the legacy v1.2.0 is newer
    // than the desktop-v1.0.46 that holds the real app, so a name-only match
    // would take the wrong one.
    const found = await resolveAgainst([LEGACY_APP, LEGACY_DESKTOP], desktopOption(mac));
    expect(found.tag).toBe("desktop-v1.0.46");
  });

  it("skips drafts and prereleases", async () => {
    const draft = { ...UNIFIED, draft: true };
    await expect(resolveAgainst([draft], desktopOption(win))).rejects.toThrow();
  });

  it("ignores tags belonging to other components", async () => {
    const tunnel = release("tunnel-v0.2.0", ["Pounce-1.5.1-Windows-x64.exe"]);
    await expect(resolveAgainst([tunnel], desktopOption(win))).rejects.toThrow();
  });
});
