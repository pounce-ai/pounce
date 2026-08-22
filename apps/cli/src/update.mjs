/**
 * `pounce update` — bring the pieces of Pounce that live on this machine up to
 * date.
 *
 * The CLI itself never rots: `npx use-pounce` fetches a fresh copy every run.
 * What rots is everything that run leaves behind, and none of it can update
 * itself:
 *
 *   • the permanent copy under ~/.pounce/app. `pounce configure --bridge`
 *     npm-installs use-pounce@<that day's version> there and pins the login
 *     service to it precisely so npm's _npx cache can't prune it away — which
 *     also means the bridge on a machine set up in March is still March's
 *     bridge, however many times its owner has since run `npx use-pounce`.
 *   • the login service, which goes on running the old copy until restarted.
 *   • the pounce-tunnel binary in ~/.pounce/bin, downloaded once when remote
 *     access was first set up and never looked at again.
 *
 * So this command reads what each piece actually is, compares it against what
 * is published, and — unless --check — replaces the ones that are behind and
 * restarts what needs restarting. The desktop app is reported but never
 * touched: it has its own updater, and two things fighting over one install is
 * worse than one being out of date.
 *
 * Bundled to dist/update.mjs by scripts/build.mjs and imported lazily by
 * bin/pounce.mjs, exactly like `configure` and `mcp`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectPlatform, restartService, serviceInstalled } from "./configure.mjs";

const POUNCE_DIR = path.join(os.homedir(), ".pounce");
const APP_DIR = path.join(POUNCE_DIR, "app");
const INSTALLED_PKG = path.join(APP_DIR, "node_modules", "use-pounce", "package.json");
const IS_WIN = process.platform === "win32";
const REGISTRY = "https://registry.npmjs.org/use-pounce/latest";

// --- terminal ----------------------------------------------------------------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = (s) => c(1, s);
const dim = (s) => c(2, s);
const green = (s) => c(32, s);
const yellow = (s) => c(33, s);
const out = (line = "") => console.log(line);

/**
 * -1 / 0 / 1 on two npm versions. Prerelease tags are dropped rather than
 * ordered: nothing here publishes them, and treating "0.7.0-rc.1" as simply
 * 0.7.0 keeps a hand-installed prerelease from being told it is behind itself.
 */
export function compareSemver(a, b) {
  const parts = (v) =>
    String(v)
      .split("-")[0]
      .split(".")
      .map((n) => Number(n) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

const behind = (have, want) => !!have && !!want && compareSemver(have, want) < 0;

/**
 * What updating would do, given what is on the machine. Pure on purpose: these
 * are the decisions worth testing, and they should be testable without npm, a
 * network, or a login service.
 *
 * Every step carries `act`, which is what --check suppresses. A step with
 * `act: false` is still reported — "already current" and "you have to do this
 * one yourself" are both answers someone came here for.
 */
export function planUpdate({
  cli,
  latest = null,
  installed = null,
  hasService = false,
  bridge = null,
  tunnel = null,
}) {
  const steps = [];

  // The permanent copy — the piece that actually goes stale, and the only one
  // this command can fix outright.
  if (installed) {
    const stale = behind(installed, latest);
    steps.push({
      id: "copy",
      label: "background bridge",
      from: installed,
      to: latest,
      act: stale,
      note: stale ? null : "already current",
    });
  } else if (hasService) {
    // A service is installed but its copy is gone — npm's cache was pruned
    // under a launcher that pointed into it. Reinstalling is `configure`'s job.
    steps.push({
      id: "copy",
      label: "background bridge",
      from: null,
      to: latest,
      act: false,
      note: "its files are missing — run `pounce configure --bridge` to reinstall",
    });
  }

  // Restarting is the half people forget: a replaced copy on disk changes
  // nothing until whatever is running it is restarted.
  const copyUpdated = steps.some((s) => s.id === "copy" && s.act);
  if (hasService && copyUpdated) {
    steps.push({ id: "service", label: "login service", act: true, note: "restart" });
  }
  if (bridge?.running && bridge.ours && behind(bridge.version, cli)) {
    steps.push({
      id: "bridge",
      label: "running bridge",
      from: bridge.version,
      to: cli,
      act: true,
      note: "restart",
    });
  }

  if (tunnel?.installed) {
    steps.push({
      id: "tunnel",
      label: "remote access",
      from: tunnel.version,
      to: tunnel.latest,
      act: !!tunnel.updateAvailable,
      note: tunnel.updateAvailable ? null : "already current",
    });
  }

  // Last, and never actionable: an npx run cannot replace itself mid-flight.
  if (behind(cli, latest)) {
    steps.push({
      id: "cli",
      label: "this command",
      from: cli,
      to: latest,
      act: false,
      note: "run `npx use-pounce@latest` to get it",
    });
  }

  return steps;
}

// --- reading the machine ------------------------------------------------------
function installedVersion() {
  try {
    return JSON.parse(readFileSync(INSTALLED_PKG, "utf8")).version || null;
  } catch {
    return null;
  }
}

async function latestPublished() {
  try {
    const res = await fetch(REGISTRY, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json())?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * What the tunnel binary is, and whether a newer one exists. Asked of the
 * BRIDGE rather than worked out here: it owns the binary, already knows how to
 * identify one too old to state its own version, and `?check=1` is the route
 * that is allowed to spend a rate-limited GitHub call.
 */
async function tunnelState(io) {
  try {
    return await io.bridgeFetch("/v1/tunnel/version?check=1");
  } catch {
    return null;
  }
}

// --- doing it -----------------------------------------------------------------
function npmInstall(version) {
  const npm = IS_WIN ? "npm.cmd" : "npm";
  const r = spawnSync(
    npm,
    [
      "install",
      "--prefix",
      APP_DIR,
      `use-pounce@${version}`,
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
    ],
    { stdio: "inherit" },
  );
  if (r.error || r.status !== 0) throw new Error(`npm install use-pounce@${version} failed`);
  const now = installedVersion();
  if (now !== version)
    throw new Error(`install finished but ~/.pounce/app holds ${now ?? "nothing"}`);
}

/**
 * Ask the bridge to replace its tunnel binary. The route answers 202 and then
 * restarts `serve`, so this call returning is not the update finishing — the
 * bridge does the digest check, the atomic swap and the rollback-on-failure,
 * and /v1/tunnel/version is where the result shows up.
 */
async function updateTunnel(io) {
  await io.bridgeFetch("/v1/tunnel/update", { method: "POST" });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await tunnelState(io);
    if (s?.lastUpdate?.state && s.lastUpdate.state !== "updating") {
      return { state: s.lastUpdate.state, version: s.version ?? null, error: s.lastUpdate.error };
    }
  }
  return { state: "unknown", version: null, error: null };
}

/** One line per piece, aligned, so the report reads as a status table. */
function report(steps) {
  const width = Math.max(...steps.map((s) => s.label.length));
  for (const s of steps) {
    const name = s.label.padEnd(width);
    const versions =
      s.from && s.to && s.from !== s.to
        ? `${s.from} → ${bold(s.to)}`
        : s.from
          ? dim(s.from)
          : s.to
            ? dim(s.to)
            : "";
    const mark = s.act ? yellow("↑") : s.note && !s.from ? yellow("!") : green("✓");
    out(`  ${mark} ${name}  ${versions}${s.note ? `  ${dim(s.note)}` : ""}`);
  }
}

export async function runUpdate({ port, version, check = false, io }) {
  out(`\n${bold("🐾 Pounce")} ${dim(`v${version}`)} — update this machine\n`);

  const det = detectPlatform();
  const alive = await io.bridgeAlive(port);
  const ui = alive ? await io.uiInfo(port).catch(() => null) : null;
  const [latest, tunnel] = await Promise.all([
    latestPublished(),
    alive ? tunnelState(io) : Promise.resolve(null),
  ]);
  if (!latest)
    out(`  ${yellow("!")} ${dim("couldn't reach the npm registry — versions unchecked")}\n`);

  const steps = planUpdate({
    cli: version,
    latest,
    installed: installedVersion(),
    hasService: serviceInstalled(det),
    bridge: { running: alive, ours: io.startedByUs(port), version: ui?.appVersion ?? null },
    tunnel,
  });

  if (!steps.length) {
    out(`  ${dim("nothing installed on this machine yet — run `pounce configure`")}\n`);
    return;
  }
  report(steps);

  const todo = steps.filter((s) => s.act);
  if (!todo.length) {
    out(`\n  ${green("✓")} everything this command manages is up to date.\n`);
    return;
  }
  if (check) {
    out(`\n  ${dim("run `pounce update` to apply the above.")}\n`);
    return;
  }

  out();
  for (const s of todo) {
    if (s.id === "copy") {
      out(`  ${dim(`installing use-pounce@${s.to} in ${APP_DIR}…`)}`);
      npmInstall(s.to);
      out(`  ${green("✓")} background bridge updated to ${s.to}`);
    } else if (s.id === "service") {
      const what = restartService(det);
      out(
        what
          ? `  ${green("✓")} ${what} restarted — it's running the new bridge now`
          : `  ${yellow("!")} couldn't restart the login service; log out and back in to pick it up`,
      );
    } else if (s.id === "bridge") {
      await io.restartBridge(port);
      out(`  ${green("✓")} bridge restarted on ${s.to}`);
    } else if (s.id === "tunnel") {
      out(`  ${dim(`replacing the remote-access component (${s.from ?? "?"} → ${s.to})…`)}`);
      const r = await updateTunnel(io);
      out(
        r.state === "ok"
          ? `  ${green("✓")} remote access updated to ${r.version ?? s.to}`
          : r.state === "rolled-back"
            ? `  ${yellow("!")} update failed and was rolled back${r.error ? dim(` (${r.error})`) : ""} — remote access still works`
            : `  ${yellow("!")} update is still running — \`pounce status\` will show the result`,
      );
    }
  }
  out(`\n  ${green("✓ Done.")}\n`);
}
