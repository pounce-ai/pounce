/**
 * "Where shall I put this?" — the OS's own save panel, asked for from here.
 *
 * No native module is involved and none is available: the desktop app is
 * react-native-macos and has no save-panel API. The bridge, though, runs inside
 * the user's GUI session, so it can ask the platform's own scripting host to
 * put up the real dialog. That is why choosing a save location is a bridge
 * concern in this codebase at all.
 *
 * Same shape as editors.mjs, and here for the same reason: the platform
 * branching lives in `agents/` so the route handler stays a couple of lines and
 * this stays testable.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

/** A save panel sits open for exactly as long as someone takes to think about
 *  it, so the only sane bound is a generous one. */
const TIMEOUT_MS = 10 * 60_000;

/** Minimal capture-and-wait; the bridge's own `exec` lives in server.mjs and
 *  this module deliberately doesn't reach back into it. */
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), TIMEOUT_MS).unref?.();
    p.on("error", () => resolve({ out, err }));
    p.on("close", () => {
      clearTimeout(timer);
      resolve({ out, err });
    });
  });
}

/**
 * Ask for a save path, defaulting to `defaultName` in `defaultDir`.
 *
 * Returns `{path}` on choice, `{canceled:true}` when the panel is dismissed —
 * an ordinary outcome, not an error — or `{error}` when the platform couldn't
 * show one.
 */
export async function chooseSavePath(defaultName, defaultDir) {
  if (IS_MAC) {
    // `choose file name` must run INSIDE the System Events tell block. Left
    // outside it the panel belongs to osascript — a background-only process
    // macOS won't let put up a window — and the call returns "User cancelled
    // (-128)" instantly, having shown nothing.
    const script = [
      'tell application "System Events"',
      "activate",
      `set f to choose file name with prompt "Save attribution report" default name ${JSON.stringify(defaultName)} default location POSIX file ${JSON.stringify(defaultDir)}`,
      "end tell",
      "POSIX path of f",
    ].join("\n");
    const r = await run("/usr/bin/osascript", ["-e", script]);
    const out = (r.out || "").trim();
    if (out) return { path: out };
    // -128 is AppleScript's "user canceled"; it arrives on stderr as text.
    if (/-128|cancel/i.test(r.err || "")) return { canceled: true };
    return { error: (r.err || "").trim() || "no path chosen" };
  }
  if (IS_WIN) {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.SaveFileDialog",
      `$d.FileName = ${JSON.stringify(defaultName)}`,
      `$d.InitialDirectory = ${JSON.stringify(defaultDir)}`,
      '$d.Filter = "JSON (*.json)|*.json"',
      "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }",
    ].join("; ");
    const r = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", ps]);
    const out = (r.out || "").trim();
    return out ? { path: out } : { canceled: true };
  }
  // Linux has no dependable panel to reach from here, so the caller's default
  // location stands rather than failing the save.
  return { path: path.join(defaultDir, defaultName) };
}

/** Where a saved file should go by default: ~/Downloads when it exists (where
 *  a person looks for one), otherwise beside the rest of our own state. */
export function defaultSaveDir() {
  const downloads = path.join(os.homedir(), "Downloads");
  return { downloads, fallback: path.join(os.homedir(), ".pounce", "exports") };
}
