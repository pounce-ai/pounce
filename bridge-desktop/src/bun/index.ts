import { BrowserWindow, Tray, Updater } from "electrobun/bun";
// The bridge lives in the repo; the desktop app just runs it in-process and
// renders the pairing QR. quiet:true suppresses the CLI console output.
// @ts-expect-error — plain .mjs, no types
import { startBridge, kittylitterPath, refreshKittylitter } from "../../server/server.mjs";
import { ensureDaemon } from "./daemon";
// The app version, shown in the pairing window's footer (kept in sync with the
// release tag via package.json / electrobun.config.ts).
import pkg from "../../package.json";

const PORT = Number(process.env.BRIDGE_PORT || 8099);

// Bootstrap the agent host in the background so the user needs nothing else.
// The window shows "Starting your agent host…" until the daemon answers.
// `ensureDaemon` may install the daemon via npx (populating the npx cache), so
// once it finishes we re-resolve the bridge's kittylitter invocation to pick up
// the freshly-installed binary instead of the slower npx fallback.
void ensureDaemon(kittylitterPath() as string)
  .then((msg) => { (refreshKittylitter as () => void)(); console.log(`[daemon] ${msg}`); })
  .catch((e) => console.error("[daemon] bootstrap failed:", e));

const info = await startBridge({ port: PORT, quiet: true, appVersion: (pkg as { version?: string }).version });
if (info?.error && !info.alreadyRunning) {
  console.error("Pounce could not start:", info.error);
} else if (info?.alreadyRunning) {
  console.log(`A Pounce is already running on ${PORT}; showing its status.`);
}

let win: BrowserWindow | null = null;
function openWindow() {
  // Load the UI straight from the bridge so /ui and /qr.svg are same-origin and
  // the port is implicit. The server is already listening (awaited above).
  win = new BrowserWindow({
    title: "Pounce",
    url: `http://127.0.0.1:${PORT}/`,
    frame: { width: 460, height: 640, x: 240, y: 120 },
  });
}
openWindow();

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

function renderMenu() {
  tray.setMenu([
    { type: "normal", label: connLabel, enabled: false },
    { type: "divider" },
    { type: "normal", label: "Show pairing window", action: "show" },
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
    } else if (!d.daemonOk) {
      label = "◌ Starting agent host…";
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
