import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Pounce",
    identifier: "app.pounce.bridge",
    version: "1.0.7",
  },
  // Auto-update: the app checks this URL on launch and self-updates (tiny BSDIFF
  // deltas, full bundle fallback). GitHub's /releases/latest/download always
  // points at the newest non-prerelease, so each release ships itself.
  release: {
    baseUrl: "https://github.com/peppyhop/pounce/releases/latest/download",
  },
  runtime: {
    // It's a tray app — closing the window leaves it running in the menu bar.
    exitOnLastWindowClosed: false,
  },
  build: {
    bun: { entrypoint: "src/bun/index.ts" },
    views: {
      mainview: { entrypoint: "src/mainview/index.ts" },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/index.css": "views/mainview/index.css",
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
