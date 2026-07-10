/**
 * Desktop launcher: daemon bootstrap + bridge, in one bundle.
 *
 * The Pounce desktop app spawns this (bundled into its Resources by the
 * "Bundle Pounce Bridge" build phase) instead of server.mjs directly, so a
 * fresh machine needs nothing else: it makes sure the kittylitter daemon is
 * running (install → autostart, or detached serve), then starts the bridge.
 * Port of bridge-desktop/src/bun/daemon.ts for plain node.
 */
import { spawn, execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { startBridge, kittylitterPath, refreshKittylitter } from "./server.mjs";

const PKG = "kittylitter";
const IS_WIN = process.platform === "win32";

// A GUI-launched app inherits a bare PATH (no Homebrew, no node version-manager
// shims), so `npx`/`node` can go unresolved. Prepend the usual install
// locations so the bootstrap works without a terminal.
function daemonEnv() {
  const home = os.homedir();
  const extra = (IS_WIN
    ? [
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, "nodejs"),
        process.env.APPDATA && path.join(process.env.APPDATA, "npm"),
        path.join(home, ".bun", "bin"),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Volta", "bin"),
      ]
    : [
        "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`,
        `${home}/.volta/bin`, `${home}/.bun/bin`,
        `${home}/.nvm/current/bin`, `${home}/.fnm/aliases/default/bin`,
      ]
  ).filter(Boolean);
  return { ...process.env, PATH: [...extra, process.env.PATH || ""].filter(Boolean).join(path.delimiter) };
}

// Windows can't spawn npm's .cmd shims without a shell; route through cmd.exe.
// Only ever used with the static, hardcoded args below.
function wrapForOS(bin, args) {
  if (!IS_WIN) return [bin, args];
  return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", bin, ...args]];
}

function statusOk(bin) {
  return new Promise((resolve) => {
    const [cmd, args] = wrapForOS(bin, ["status"]);
    const child = execFile(cmd, args, { timeout: 8000, env: daemonEnv() }, (err, stdout) => {
      // `status` prints "pid: …" when the daemon is live (it also exits 0 in
      // file-only mode with "pid: 0", so require a nonzero pid — treating
      // "pid: 0" as running is how the bootstrap used to declare victory
      // while the daemon was actually down).
      resolve(!err && /pid\s*:\s*0*[1-9]/i.test(stdout || ""));
    });
    child.on("error", () => resolve(false));
  });
}

function run(bin, args, detached = false) {
  return new Promise((resolve) => {
    try {
      const [cmd, wrapped] = wrapForOS(bin, args);
      const child = spawn(cmd, wrapped, {
        detached,
        stdio: "ignore",
        windowsHide: true,
        env: daemonEnv(),
      });
      child.on("error", () => resolve(false));
      if (detached) {
        child.unref();
        resolve(true); // long-running; don't wait
      } else {
        child.on("exit", (code) => resolve(code === 0));
      }
    } catch {
      resolve(false);
    }
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ensure the daemon is up. Best-effort, never stops a running daemon. */
async function ensureDaemon(klPath) {
  if (await statusOk(klPath)) return "daemon already running";
  if (klPath !== PKG && (await statusOk(PKG))) return "daemon already running (PATH)";

  const haveLocal = klPath !== PKG;
  const tryStart = async (bin, prefix) => {
    // Prefer `install` (autostart + start); fall back to detached `serve`.
    if (await run(bin, [...prefix, "install"])) {
      await delay(2500);
      if (await statusOk(haveLocal ? klPath : PKG)) return true;
    }
    return run(bin, [...prefix, "serve"], true);
  };

  if (haveLocal && (await tryStart(klPath, []))) return "started local daemon";
  if (await tryStart("npx", ["-y", `${PKG}@latest`])) return "started daemon via npx";
  return "could not start daemon — is npx/node installed?";
}

// Boot the daemon in the background (the bridge starts serving immediately and
// warms its caches once the daemon answers), then start the bridge in-process.
void ensureDaemon(kittylitterPath())
  .then((msg) => {
    refreshKittylitter();
    console.log(`[daemon] ${msg}`);
  })
  .catch((e) => console.error("[daemon] bootstrap failed:", e));

void startBridge({ quiet: false });
