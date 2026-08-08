/**
 * Which editors this machine actually has, and opening a folder in one.
 *
 * A purpose-built pair of endpoints rather than letting the client compose a
 * shell string through /v1/exec: the menu has to show only what's installed
 * (an "Open in Zed" that does nothing is worse than no entry), and the launch
 * has to escape a path the user never typed. Both of those are one decision
 * each, made here, rather than a template in the UI.
 *
 * Detection is a stat, never a spawn. `mdfind`/`which` per candidate is a dozen
 * processes every time a menu opens; a bundle path either exists or it doesn't.
 */
import { accessSync, constants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { agentEnv } from "./env.mjs";

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

/**
 * The editors worth offering, most-likely-first.
 *
 * `mac` is the .app bundle name (what `open -a` takes, and what we stat for).
 * `bin` is the command on Linux and the fallback everywhere — a Zed installed
 * outside /Applications still answers on PATH.
 *
 * Ordered by how likely a Pounce user is to have it as their editor, because
 * this order is the menu order and the first entry gets the keyboard shortcut.
 */
const EDITORS = [
  { id: "zed", name: "Zed", mac: "Zed", bin: "zed" },
  { id: "vscode", name: "VS Code", mac: "Visual Studio Code", bin: "code" },
  { id: "cursor", name: "Cursor", mac: "Cursor", bin: "cursor" },
  { id: "windsurf", name: "Windsurf", mac: "Windsurf", bin: "windsurf" },
  { id: "sublime", name: "Sublime Text", mac: "Sublime Text", bin: "subl" },
  { id: "webstorm", name: "WebStorm", mac: "WebStorm", bin: "webstorm" },
  { id: "intellij", name: "IntelliJ IDEA", mac: "IntelliJ IDEA", bin: "idea" },
  { id: "nova", name: "Nova", mac: "Nova", bin: null },
  { id: "xcode", name: "Xcode", mac: "Xcode", bin: null },
  { id: "androidstudio", name: "Android Studio", mac: "Android Studio", bin: "studio" },
];

/** The file manager, which is always present and is named differently on each
 *  platform — "Reveal in Finder" is the phrase Mac users look for. */
const FILES = {
  id: "files",
  name: IS_MAC ? "Finder" : IS_WIN ? "File Explorer" : "File manager",
};

/** Where a .app can live. A user-space install under ~/Applications is common
 *  for anything not from the App Store and is easy to forget. */
const APP_DIRS = ["/Applications", "/System/Applications", path.join(os.homedir(), "Applications")];

/** The bundle path for a macOS app name, or null if it isn't installed. */
function macApp(name) {
  for (const dir of APP_DIRS) {
    const p = path.join(dir, `${name}.app`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** First executable named `bin` on PATH, or null. Uses the same PATH the agents
 *  get (agentEnv), which includes the login-shell additions a GUI-launched
 *  process would otherwise be missing — that's where Homebrew lives. */
function onPath(bin) {
  if (!bin) return null;
  const exts = IS_WIN ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (agentEnv().PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        accessSync(p, constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
}

/**
 * Editors installed on this machine, plus the file manager.
 *
 * Cached for a minute: the menu opens on every thread switch and an install
 * doesn't happen mid-session, but a short TTL means installing an editor and
 * looking again works without restarting the bridge.
 */
let cache = { at: 0, value: null };
const TTL_MS = 60_000;

export function listEditors() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;
  const out = [];
  for (const e of EDITORS) {
    const app = IS_MAC && e.mac ? macApp(e.mac) : null;
    const bin = app ? null : onPath(e.bin);
    if (app || bin) out.push({ id: e.id, name: e.name });
  }
  out.push(FILES);
  cache = { at: Date.now(), value: out };
  return out;
}

/** Drop the memo — after an install, or for a test. */
export function resetEditorCache() {
  cache = { at: 0, value: null };
}

/**
 * Open `dir` in the named target.
 *
 * Arguments are passed as an ARRAY, never interpolated into a shell string: a
 * project path is not something the user typed here, it comes from a
 * transcript, and a folder with a space or a quote in it would otherwise either
 * fail or run something unintended.
 *
 * Detached and fully ignored on stdio so a GUI editor that outlives this
 * request can't keep the response open or die with the bridge.
 */
export function openIn(id, dir) {
  if (!dir || !existsSync(dir)) return { ok: false, error: "no such directory" };

  const spec = EDITORS.find((e) => e.id === id);
  if (id !== FILES.id && !spec) return { ok: false, error: "unknown target" };

  let cmd;
  let args;
  if (id === FILES.id) {
    // Every platform's "show me this folder" is a different program.
    if (IS_MAC) [cmd, args] = ["open", [dir]];
    else if (IS_WIN) [cmd, args] = ["explorer.exe", [dir]];
    else [cmd, args] = ["xdg-open", [dir]];
  } else {
    const app = IS_MAC && spec.mac ? macApp(spec.mac) : null;
    if (app) {
      // `open -a` by BUNDLE PATH, not by name: two apps can share a display
      // name, and the path is the one we actually verified exists.
      [cmd, args] = ["open", ["-a", app, dir]];
    } else {
      const bin = onPath(spec.bin);
      if (!bin) return { ok: false, error: "not installed" };
      [cmd, args] = [bin, [dir]];
    }
  }

  try {
    const p = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      env: agentEnv(),
      windowsHide: true,
    });
    p.on("error", () => {});
    p.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
