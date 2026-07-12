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
import { readConfig, binOverride } from "./config.mjs";

const IS_WIN = process.platform === "win32";

export function agentEnv() {
  const home = os.homedir();
  const cfg = readConfig();
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
  // A user-pinned binary's directory goes on the FRONT so both the binary itself
  // and any `#!/usr/bin/env node` shebang inside a wrapper resolve to the pinned
  // toolchain. Then the caller's PATH, then their extra dirs, then our defaults.
  const overrideDirs = Object.values(cfg.bins).map((p) => path.dirname(p));
  const PATH = [...overrideDirs, process.env.PATH || "", ...cfg.extraPath, ...extra.filter(Boolean)]
    .filter(Boolean)
    .join(path.delimiter);
  // cfg.env comes before PATH so our computed PATH always wins.
  return { ...process.env, ...cfg.env, PATH };
}

/**
 * How to invoke a named binary: the user's pinned absolute path if set, else the
 * bare name for PATH resolution. Use this instead of spawning the literal name
 * so custom setups (shadowed/oddly-installed CLIs) can be fixed from the app.
 */
export function binPath(name) {
  return binOverride(name) || name;
}

/**
 * The machine's reachable LAN IPv4 address(es), best candidate first. The naive
 * "first non-internal IPv4" breaks on Macs with a VPN, Docker, Tailscale, or
 * Ethernet+Wi-Fi, where it can advertise an address the phone can't reach — the
 * classic "pairing QR doesn't work on the same Wi-Fi". Prefer real private-LAN
 * addresses on physical interfaces (en*), skip virtual/link-local/CGNAT.
 */
export function lanIps() {
  const VIRTUAL = /^(utun|awdl|llw|bridge|vnic|vbox|vmnet|docker|tap|tun|ham|zt|gpd|ppp)/i;
  const isPrivate = (a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  const rows = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue; // link-local
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue; // CGNAT (Tailscale)
      rows.push({ address: a.address, priv: isPrivate(a.address), phys: /^en\d/i.test(name) });
    }
  }
  rows.sort((x, y) => Number(y.priv) - Number(x.priv) || Number(y.phys) - Number(x.phys));
  return rows.map((r) => r.address);
}

/** The single best LAN IP to advertise (or null when offline). */
export function primaryLanIp() {
  return lanIps()[0] || null;
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
      p = spawn(binPath(bin), args, { env: agentEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch { return resolve(null); }
    let out = "";
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 5000);
    p.stdout.on("data", (d) => { if (out.length < 4096) out += d; });
    p.on("close", (code) => { clearTimeout(t); resolve(code === 0 ? out.trim().split("\n")[0] || "" : null); });
    p.on("error", () => { clearTimeout(t); resolve(null); });
  });
}
