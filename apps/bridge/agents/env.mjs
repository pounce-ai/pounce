/**
 * Spawn environment for agent CLIs. GUI-launched apps inherit a bare PATH (no
 * Homebrew, no version-manager shims), so `claude`/`opencode`/`codex` — and the
 * `env node` shebangs inside them — can fail to resolve. APPEND the usual
 * install locations: a tool the caller's PATH already resolves must win, or a
 * broken Homebrew toolchain shadows a working version-manager one (seen live:
 * homebrew node linked against a deleted libllhttp dylib killed every spawn).
 */
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const IS_WIN = process.platform === "win32";

export function agentEnv() {
  const home = os.homedir();
  const extra = IS_WIN
    ? [
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, "nodejs"),
        process.env.APPDATA && path.join(process.env.APPDATA, "npm"),
        path.join(home, ".bun", "bin"),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Volta", "bin"),
      ]
    : [
        "/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`,
        `${home}/.volta/bin`, `${home}/.bun/bin`, `${home}/.claude/local`,
        `${home}/.nvm/current/bin`, `${home}/.fnm/aliases/default/bin`,
      ];
  const PATH = [process.env.PATH || "", ...extra.filter(Boolean)].filter(Boolean).join(path.delimiter);
  return { ...process.env, PATH };
}

/**
 * Probe whether a CLI answers `--version` (≤5s). Resolves the trimmed version
 * string or null. Used for `isAvailable` so an agent without its binary simply
 * doesn't appear in the app — same UX as the old daemon's `available` flag.
 */
export function binVersion(bin, args = ["--version"]) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(bin, args, { env: agentEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch { return resolve(null); }
    let out = "";
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 5000);
    p.stdout.on("data", (d) => { if (out.length < 4096) out += d; });
    p.on("close", (code) => { clearTimeout(t); resolve(code === 0 ? out.trim().split("\n")[0] || "" : null); });
    p.on("error", () => { clearTimeout(t); resolve(null); });
  });
}
