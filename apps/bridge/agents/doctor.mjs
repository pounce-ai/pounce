/**
 * Pounce Doctor — a runtime health check for the native host so a fresh user
 * (or a custom setup) can see exactly what's missing instead of a blank app.
 * Everything here is best-effort and side-effect-free.
 */
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { agentEnv, binVersion, lanIps } from "./env.mjs";

const IS_WIN = process.platform === "win32";

/** Absolute path a binary resolves to on the host's PATH (with our extra dirs). */
function whichBin(name) {
  try {
    const r = IS_WIN
      ? spawnSync("where", [name], { env: agentEnv(), encoding: "utf8" })
      : spawnSync("/bin/sh", ["-c", `command -v ${name}`], { env: agentEnv(), encoding: "utf8" });
    return r.stdout?.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

/** The CLI binary each agent needs installed to run turns. */
const AGENT_BIN = { claude: "claude", codex: "codex", opencode: "opencode" };

function tunnelBinary() {
  const candidates = [
    process.env.POUNCE_TUNNEL_BIN,
    // Bundled next to the launcher (desktop app), then the legacy install dir.
    new URL(`./tunnel/${IS_WIN ? "pounce-tunnel.exe" : "pounce-tunnel"}`, import.meta.url).pathname,
    path.join(os.homedir(), ".pounce", "bin", IS_WIN ? "pounce-tunnel.exe" : "pounce-tunnel"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

/**
 * Build the full report. `adapters` is the host's list of agent adapters (each
 * with id/displayName/isAvailable/listThreads).
 */
export async function buildDoctorReport(adapters) {
  const agents = await Promise.all(
    adapters.map(async (a) => {
      const bin = AGENT_BIN[a.id];
      const binPath = bin ? whichBin(bin) : null;
      const version = bin ? await binVersion(bin) : null;
      const installed = !!version || !!binPath || (await a.isAvailable().catch(() => false));
      let sessionCount = 0;
      try {
        sessionCount = (await a.listThreads()).length;
      } catch {}
      return { id: a.id, name: a.displayName, installed, path: binPath, version, sessionCount };
    }),
  );

  const gitVersion = await binVersion("git");
  const tunnelBin = tunnelBinary();
  const sessionsTotal = agents.reduce((s, a) => s + a.sessionCount, 0);
  const ips = lanIps();
  const port = Number(process.env.BRIDGE_PORT || 8099);

  return {
    // How the phone reaches this Mac on the LAN. `advertised` is the address
    // baked into the pairing QR; `ips` are all candidates (a multi-interface Mac
    // — VPN/Docker/Ethernet — can advertise an unreachable one).
    network: { advertised: ips[0] || null, ips, port, reachable: ips.length > 0 },
    ok:
      agents.some((a) => a.installed) && sessionsTotal >= 0, // "usable" = at least one agent CLI
    node: { ok: true, path: process.execPath, version: process.version.replace(/^v/, "") },
    git: { ok: !!gitVersion, version: gitVersion },
    agents,
    // Off-LAN reachability. No binary → LAN-only (works on the same network).
    tunnel: { ok: !!tunnelBin, path: tunnelBin, mode: tunnelBin ? "internet" : "lan-only" },
    sessionsTotal,
    host: os.hostname().replace(/\.local$/, ""),
    home: os.homedir(),
    platform: process.platform,
  };
}
