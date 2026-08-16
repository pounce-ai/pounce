import { BrowserWindow, Tray, Updater } from "electrobun/bun";
// The bridge lives in the repo; the desktop app just runs it in-process and
// renders the pairing QR. quiet:true suppresses the CLI console output. The
// bridge runs the native agent host and spawns pounce-tunnel (off-LAN iroh
// access) itself — nothing else needs bootstrapping.
// @ts-expect-error — plain .mjs, no types
import { startBridge } from "../../server/server.mjs";
// The app version, shown in the pairing window's footer (kept in sync with the
// release tag via package.json / electrobun.config.ts).
import pkg from "../../package.json";

const PORT = Number(process.env.BRIDGE_PORT || 8099);

// Install the bundled pounce-tunnel to ~/.pounce/bin (where the bridge
// auto-spawns it) before the bridge starts. Copy only when missing or changed
// so we never rewrite a binary a previous session might still be running.
try {
  const { chmodSync, copyFileSync, mkdirSync, rmSync, statSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const bundled = fileURLToPath(new URL("../views/pounce-tunnel", import.meta.url));
  const dir = join(homedir(), ".pounce", "bin");
  const dest = join(dir, process.platform === "win32" ? "pounce-tunnel.exe" : "pounce-tunnel");
  const size = (p: string) => { try { return statSync(p).size; } catch { return -1; } };
  if (size(bundled) > 0 && size(bundled) !== size(dest)) {
    mkdirSync(dir, { recursive: true });
    rmSync(dest, { force: true });
    copyFileSync(bundled, dest);
    chmodSync(dest, 0o755);
    console.log(`[tunnel] installed ${dest}`);
  }
} catch (e) {
  console.error("[tunnel] install skipped:", e);
}

// zigpty degrades silently: with no native binding it falls back to a pure-JS
// pipe, which has no real TTY, so agent TUIs don't render and prompts can't be
// answered from the phone — the app looks fine and one feature is just gone.
// The binding is a per-platform .node copied to app/prebuilds by the build, so
// a packaging slip is the likely cause; say so at startup rather than never.
try {
  const { hasNative } = await import("zigpty");
  if (!hasNative) console.warn("[pty] no native TTY — interactive prompts will not work");
} catch (e) {
  console.warn("[pty] zigpty unavailable:", e);
}

// The bundled web app (the full Pounce UI — sidebar, tabs, transcripts),
// built by `sync-web` and copied to views/web. The bridge serves it at GET /
// so it is same-origin with /v1; the pairing page moves to /pair. Absent in
// plain local dev builds AND in macOS bundles (electrobun.config.ts skips the
// copy there — on a Mac the native desktop app is the real UI and this app is
// its companion tray), in which case / stays the pairing page and everything
// behaves as before.
const webDir = await (async () => {
  try {
    const { fileURLToPath } = await import("node:url");
    const { existsSync } = await import("node:fs");
    const dir = fileURLToPath(new URL("../views/web", import.meta.url));
    return existsSync(`${dir}/index.html`) ? dir : null;
  } catch {
    return null;
  }
})();

const info = await startBridge({
  port: PORT,
  quiet: true,
  appVersion: (pkg as { version?: string }).version,
  webDir,
});
if (info?.error && !info.alreadyRunning) {
  console.error("Pounce could not start:", info.error);
} else if (info?.alreadyRunning) {
  console.log(`A Pounce is already running on ${PORT}; showing its status.`);
}

let win: BrowserWindow | null = null;
function openWindow() {
  // Load the UI straight from the bridge so everything is same-origin and the
  // port is implicit. With a bundled web app, / is the full Pounce UI and the
  // window is sized like an app; without one it's the pairing QR card.
  win = new BrowserWindow({
    title: "Pounce",
    url: `http://127.0.0.1:${PORT}/`,
    frame: webDir
      ? { width: 1280, height: 820, x: 120, y: 80 }
      : { width: 460, height: 640, x: 240, y: 120 },
  });
}
openWindow();

// The pairing QR in its own small window. Only offered when / is the web app —
// otherwise the main window IS the pairing page and this would duplicate it.
let pairWin: BrowserWindow | null = null;
function openPairWindow() {
  pairWin = new BrowserWindow({
    title: "Pair a device",
    url: `http://127.0.0.1:${PORT}/pair`,
    frame: { width: 460, height: 640, x: 300, y: 140 },
  });
}

// Set the image in the constructor so the `template` flag is honored — macOS
// then renders the paw adaptively (white on a dark menu bar, dark on a light
// one). Calling setImage() afterward would drop the template flag.
// Windows/Linux have no template rendering, so the near-black template glyph
// would vanish on their (usually dark) taskbars — use the full-color app icon.
const isMac = process.platform === "darwin";
const tray = new Tray({
  title: "",
  image: isMac ? "views://tray.png" : "views://tray-color.png",
  template: isMac,
  width: 18,
  height: 18,
});

// Two labels drive the menu: the live connection status (top, not clickable)
// and the manual updater item's transient state.
let connLabel = "○ Ready to pair";
let updateLabel = "Check for Updates…";
let checking = false;

// Today's activity and the plan quota, mirroring the Mac app's menu bar
// (-[AppDelegate refreshUsage] in AppDelegate.mm). Both surfaces must read the
// same, so the formatting rules are copied rather than reinvented.
let usageLabel = "Today — …";
let quotaLabel = ""; // empty → the row is omitted, as on macOS

/**
 * 165_000_000 → "165M". Kept byte-identical to `fmtTokens` in
 * packages/app/src/ui/format.ts — NOT imported from it, because this file is
 * compiled into a standalone tray binary that must not pull in the React Native
 * package's module graph.
 *
 * It had drifted: the old copy rendered 1M as "1.0M" and 165M as "165.0M" while
 * every in-app surface said "1M" and "165M", so the same number read differently
 * in the menu bar and in the window.
 */
function fmtTokens(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) {
    const b = n / 1_000_000_000;
    return `${b >= 100 ? Math.round(b) : b.toFixed(1).replace(/\.0$/, "")}B`;
  }
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${Math.round(n)}`;
}

function renderMenu() {
  tray.setMenu([
    { type: "normal", label: connLabel, enabled: false },
    { type: "normal", label: usageLabel, enabled: false },
    // Hidden until an agent reports one — on a subscription this is the number
    // that matters, but not every agent meters a window.
    ...(quotaLabel ? [{ type: "normal" as const, label: quotaLabel, enabled: false }] : []),
    { type: "divider" },
    { type: "normal", label: webDir ? "Open Pounce" : "Show pairing window", action: "show" },
    ...(webDir ? [{ type: "normal" as const, label: "Show pairing QR", action: "pair" }] : []),
    { type: "normal", label: updateLabel, action: "check-update", enabled: !checking },
    { type: "divider" },
    { type: "normal", label: "Quit Pounce", action: "quit" },
  ]);
}
renderMenu();

tray.on("tray-clicked", (event: any) => {
  switch (event.data?.action) {
    case "show":
      openWindow();
      break;
    case "pair":
      openPairWindow();
      break;
    case "check-update":
      void checkForUpdateNow();
      break;
    case "quit":
      tray.remove();
      process.exit(0);
      break;
  }
});

// Poll the bridge's own status and reflect connection state in the tray. Only
// re-render the menu when the label actually changes, so we don't thrash it.
let lastLabel = "";
async function pollStatus() {
  let label = "○ Ready to pair";
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/ui`, { signal: AbortSignal.timeout(2500) });
    const d: any = await r.json();
    if (d.connected) {
      const n = d.devices && d.devices > 0 ? d.devices : 1;
      label = `● Connected · ${n} device${n === 1 ? "" : "s"}`;
    }
  } catch {
    label = "◌ Starting…";
  }
  if (label !== lastLabel) {
    lastLabel = label;
    connLabel = label;
    renderMenu();
    // Text beside the tray icon is a macOS menu-bar concept; skip elsewhere.
    if (isMac) tray.setTitle(label.startsWith("●") ? "●" : "");
  }
}
void pollStatus();
setInterval(() => void pollStatus(), 3000);

// The bridge's /ui is loopback-only and hands out its own pairing token, so the
// tray needs no configuration — the same self-pairing trick the Mac tray uses.
let token: string | null = null;
async function bridgeJson(path: string, auth = true): Promise<any | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      signal: AbortSignal.timeout(3000),
      headers: auth && token ? { authorization: `Bearer ${token}` } : {},
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null; // a stalled bridge leaves the last value in place
  }
}

async function refreshReadouts() {
  token ??= (await bridgeJson("/ui", false))?.token ?? null;
  if (!token) return;

  // Two independent reads of the same loopback bridge — serialising them
  // doubled the window in which the tray showed stale numbers.
  const [activity, quotaRes] = await Promise.all([
    bridgeJson("/v1/activity?days=1"),
    bridgeJson("/v1/quota"),
  ]);

  const totals = activity?.totals;
  if (!totals) {
    token = null; // token went stale (bridge restarted) — re-fetch next tick
    return;
  }
  const sessions = Number(totals.sessions ?? 0);
  let line = `Today — ${fmtTokens(Number(totals.tokens ?? 0))} tokens · ${sessions} ${sessions === 1 ? "session" : "sessions"}`;
  // `cost` is null unless an agent actually stated a price — the bridge never
  // prices tokens itself. "Not known" is not zero, so an absent cost renders as
  // nothing at all, never as "$0.00".
  if (typeof totals.cost === "number") {
    line += ` · ${totals.costComplete ? "" : "~"}$${totals.cost.toFixed(2)}`;
  }

  const quota = quotaRes?.quota ?? {};
  const parts: string[] = [];
  for (const agent of Object.values<any>(quota)) {
    for (const w of agent?.windows ?? []) {
      if (typeof w?.usedPercent === "number") parts.push(`${w.label} ${Math.round(w.usedPercent)}%`);
    }
  }

  const nextQuota = parts.length ? `Plan — ${parts.join(" · ")}` : "";
  if (line !== usageLabel || nextQuota !== quotaLabel) {
    usageLabel = line;
    quotaLabel = nextQuota;
    renderMenu();
  }
}
void refreshReadouts();
setInterval(() => void refreshReadouts(), 30_000);

// Auto-update: download new releases in the background, then apply (relaunch
// into the new version) only when no phone is connected — so a session is never
// interrupted. Disabled automatically on the dev channel.
let updatePending = false;
async function checkForUpdate() {
  try {
    const info = await Updater.checkForUpdate();
    if (info.updateAvailable) {
      await Updater.downloadUpdate();
      updatePending = true;
      console.log("[update] downloaded a new version; will apply when idle.");
    }
  } catch { /* offline or no release host — ignore */ }
}
async function applyUpdateIfIdle() {
  if (!updatePending) return;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/ui`, { signal: AbortSignal.timeout(2000) });
    if ((await r.json())?.connected) return; // a phone is active — wait
  } catch { /* treat unreachable as idle */ }
  updatePending = false;
  console.log("[update] applying update and relaunching…");
  try { await Updater.applyUpdate(); } catch (e) { console.error("[update] apply failed:", e); }
}
void checkForUpdate();
setInterval(() => void checkForUpdate(), 6 * 60 * 60 * 1000); // re-check every 6h
setInterval(() => void applyUpdateIfIdle(), 60 * 1000);       // apply when idle

// Manual "Check for Updates" — the same machinery as the background path, but
// triggered on demand with immediate tray feedback. Keeps the idle-safety: if a
// phone is connected, the downloaded update is applied later by applyUpdateIfIdle
// rather than interrupting the session.
async function checkForUpdateNow() {
  if (checking) return;
  checking = true;
  updateLabel = "Checking for updates…";
  renderMenu();
  try {
    const upd = await Updater.checkForUpdate();
    if (upd.updateAvailable) {
      updateLabel = "Downloading update…";
      renderMenu();
      await Updater.downloadUpdate();
      updatePending = true;
      updateLabel = "Update ready — applies when idle";
      void applyUpdateIfIdle(); // relaunches now if no phone is connected
    } else {
      updateLabel = "You're up to date";
    }
  } catch (e) {
    console.error("[update] manual check failed:", e);
    updateLabel = "Update check failed";
  } finally {
    checking = false;
    renderMenu();
    // Restore the default label after a few seconds.
    setTimeout(() => { if (!checking) { updateLabel = "Check for Updates…"; renderMenu(); } }, 5000);
  }
}

console.log("Pounce is running. Scan the QR in the window to connect your phone.");
