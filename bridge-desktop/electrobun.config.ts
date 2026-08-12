import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import type { ElectrobunConfig } from "electrobun";

/**
 * zigpty's native PTY binding, for the host being built.
 *
 * The bridge's pty.mjs hosts interactive (answerable) agent sessions in a real
 * TTY. zigpty resolves its addon as `new URL("../prebuilds/<name>.node",
 * import.meta.url)` and that URL survives bundling, so from app/bun/index.js it
 * lands on app/prebuilds/. Without it `hasNative` is false and zigpty degrades
 * to a pure-JS pipe: no TTY, so agent TUIs don't render and prompts can't be
 * answered from the phone, while everything else looks fine.
 *
 * Only the host's own prebuild is copied. Shipping all eight was tempting (they
 * total 336KB) but wrong: macOS notarization inspects every executable in the
 * bundle and rejects unsigned ones, so the win32/linux .node files — useless
 * inside a .app — failed the build outright. The macOS job signs the one that
 * remains before packaging (see release-bridge.yml).
 */
function zigptyPrebuilds(): Record<string, string> {
  const os = platform() === "android" ? "linux" : platform();
  const base = `zigpty.${os}-${arch()}`;
  // glibc vs musl is resolved at runtime by zigpty, so Linux needs both.
  const names = os === "linux" ? [base, `${base}-musl`] : [base];
  const entries = names
    .map((n) => [`../node_modules/zigpty/prebuilds/${n}.node`, `prebuilds/${n}.node`] as const)
    .filter(([src]) => existsSync(src));
  if (entries.length === 0) {
    throw new Error(
      `no zigpty prebuild for ${os}-${arch()} — interactive prompts would silently stop working`,
    );
  }
  return Object.fromEntries(entries);
}

export default {
  app: {
    name: "Pounce",
    identifier: "app.pounce.bridge",
    version: "1.1.5",
  },
  // Auto-update: the app checks this URL on launch and self-updates (tiny BSDIFF
  // deltas, full bundle fallback).
  //
  // NOT /releases/latest/download, which is the obvious choice and is already
  // taken. The macOS desktop app's Sparkle feed (SUFeedURL in
  // desktop/macos/PounceDesktop-macOS/Info.plist) resolves through that exact
  // tag-less path, and that URL is baked into every shipped desktop build — it
  // cannot be moved without stranding them. Two updaters cannot both own
  // "latest": whichever released last would 404 the other's manifest.
  //
  // So the bridge uses a rolling `bridge-latest` tag instead. CI re-uploads the
  // auto-update artifacts to that one release every time (see
  // .github/workflows/release-bridge.yml), giving a stable moving pointer that
  // leaves GitHub's "latest" to Sparkle.
  //
  // Installs from the deprecated v1.0.20 and earlier have a different URL baked
  // into their binary and will not pick these up; that channel is not being
  // kept alive, so those few installs need a manual reinstall.
  release: {
    baseUrl: "https://github.com/pounce-ai/pounce/releases/download/bridge-latest",
  },
  runtime: {
    // It's a tray app — closing the window leaves it running in the menu bar.
    exitOnLastWindowClosed: false,
  },
  build: {
    // No `views`: the window loads the BRIDGE's own pairing page over http
    // (see src/bun/index.ts), so there is no webview bundle to build. The copy
    // table below still populates views/ with the binaries and icons the bun
    // process resolves at runtime.
    bun: { entrypoint: "src/bun/index.ts" },
    copy: {
      // pounce-tunnel (iroh p2p, off-LAN access) — built per-platform by CI
      // into assets/; absent in plain local dev builds, hence the guard.
      ...(existsSync("assets/pounce-tunnel") ? { "assets/pounce-tunnel": "views/pounce-tunnel" } : {}),
      // zigpty's native PTY addon for this host — see zigptyPrebuilds() above.
      ...zigptyPrebuilds(),
      "assets/tray.png": "views/tray.png",
      // Full-color tray icon for Windows/Linux, where macOS template rendering
      // doesn't exist and the dark template glyph would disappear.
      "assets/icon.iconset/icon_32x32.png": "views/tray-color.png",
    },
    mac: {
      bundleCEF: false,
      icons: "assets/icon.iconset",
      // Sign when a Developer ID is present; only let Electrobun notarize when
      // notarization creds are also present. (release-bridge.sh signs here and
      // notarizes separately via the `asc` CLI's stored credentials.)
      codesign: !!process.env.ELECTROBUN_DEVELOPER_ID,
      notarize: !!(process.env.ELECTROBUN_APPLEID || process.env.ELECTROBUN_APPLEAPIKEY),
    },
    // PNG icons are auto-converted (png-to-ico for the Windows installer);
    // png-to-ico caps input at 256px, so don't point it at the 512 variant.
    linux: { bundleCEF: false, icon: "assets/icon.iconset/icon_512x512.png" },
    win: { bundleCEF: false, icon: "assets/icon.iconset/icon_256x256.png" },
  },
} satisfies ElectrobunConfig;
