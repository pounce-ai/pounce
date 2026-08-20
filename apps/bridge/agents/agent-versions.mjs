/**
 * Is each agent CLI up to date, and can we update it from here?
 *
 * The bridge already knew what version of each agent was INSTALLED — doctor
 * reports it. What it never knew was whether that was the current one, so a
 * machine could sit months behind on Claude Code or opencode and nothing said
 * so. (At the time this was written, three of the four agents on the author's
 * machine were behind.)
 *
 * TWO RULES, both learned the hard way elsewhere in this codebase.
 *
 * Never guess a comparison. Three of these CLIs are semver and one
 * (`cursor-agent`) is a date plus a build sha — `2026.07.16-899851b`. Semver
 * logic will happily rank two of those and be wrong, so where a comparison
 * cannot be made honestly this reports `updateAvailable: null` and the UI shows
 * nothing. A missing badge is fine; a wrong one sends someone to reinstall a CLI
 * that was already current.
 *
 * Never check the network unless asked. This hangs off a page that re-syncs
 * every 20 seconds, and a registry lookup per agent per sync is both rude and
 * pointless — CLIs do not ship that often. `check` has to be passed explicitly,
 * and the answer is cached for hours. Same rule as tunnel-bin's `?check=1`.
 *
 * Updating runs the CLI's OWN updater rather than a package manager. Each of
 * these was installed differently — npm, homebrew, a curl script — and only the
 * CLI knows which. `npm i -g` would be wrong for at least two of them and would
 * quietly install a second copy that shadows the real one.
 */
import { binPath, binVersion, resolveBin } from "./env.mjs";
import { agentEnv } from "./env.mjs";
import { spawn } from "node:child_process";
import { compareVersions } from "./tunnel-bin.mjs";

/**
 * Where each agent's current version comes from, and how it updates itself.
 *
 * `npm` is the registry package. `script` is an install script that pins the
 * version it fetches — the only handle Cursor exposes, and a scrape, so it is
 * treated as best-effort throughout.
 */
export const AGENTS = {
  claude: { bin: "claude", npm: "@anthropic-ai/claude-code", update: ["update"], calver: false },
  codex: { bin: "codex", npm: "@openai/codex", update: ["update"], calver: false },
  opencode: { bin: "opencode", npm: "opencode-ai", update: ["upgrade"], calver: false },
  cursor: {
    bin: "cursor-agent",
    script: "https://cursor.com/install",
    update: ["update"],
    calver: true,
  },
};

/** How long a "latest" answer is good for. CLIs don't ship by the minute, and
 *  this is the difference between one registry call a morning and one a page
 *  view. */
const LATEST_TTL_MS = 6 * 60 * 60_000;
const latestCache = new Map(); // agent -> { at, version }

/**
 * The comparable version inside whatever the CLI printed.
 *
 * `--version` output is not a version: it is `2.1.237 (Claude Code)`, or
 * `codex-cli 0.146.0`, or a bare number. Take the first dotted-numeric token and
 * keep any `-suffix` attached to it, which is what carries Cursor's build sha.
 */
export function normalizeVersion(raw) {
  if (!raw) return null;
  const m = String(raw).match(/\d+(?:\.\d+)+(?:-[A-Za-z0-9.]+)?/);
  return m ? m[0] : null;
}

async function fetchJson(url, timeoutMs = 10_000) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "pounce-bridge" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** The newest published version of an agent's CLI, or null if we cannot tell. */
async function latestFor(id) {
  const spec = AGENTS[id];
  if (!spec) return null;
  const hit = latestCache.get(id);
  if (hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.version;
  let version = null;
  try {
    if (spec.npm) {
      const body = await fetchJson(
        `https://registry.npmjs.org/${spec.npm.replace("/", "%2f")}/latest`,
      );
      version = normalizeVersion(body?.version);
    } else if (spec.script) {
      // Cursor publishes no registry entry; its install script pins the version
      // it downloads. A scrape, so it is allowed to come back empty rather than
      // to guess — the shape may change without notice and a wrong answer here
      // is worse than none.
      const res = await fetch(spec.script, {
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "pounce-bridge" },
      });
      if (res.ok) {
        const text = await res.text();
        const m = text.match(/\/lab\/(\d{4}\.\d{2}\.\d{2}-[A-Za-z0-9]+)\//);
        version = m ? m[1] : null;
      }
    }
  } catch {
    // Offline, rate-limited, or the shape moved. Unknown is a real answer.
    version = null;
  }
  // Cached even when null, so a machine with no network does not retry per view.
  latestCache.set(id, { at: Date.now(), version });
  return version;
}

/**
 * Is `installed` behind `latest`, as far as we can honestly tell?
 *
 * Returns true, false, or NULL for "cannot say" — which is a real answer and
 * the one the UI must render as silence.
 *
 * The CalVer case is why this is not just compareVersions. `2026.07.16-899851b`
 * and `2026.08.11-e8db854` differ in the date, which ranks correctly. Two builds
 * on the SAME date differ only by a sha, which has no order at all — comparing
 * them lexically produces a confident answer that is meaningless, so that case
 * is unknown.
 */
export function isBehind(installed, latest, { calver = false } = {}) {
  if (!installed || !latest) return null;
  if (installed === latest) return false;
  if (calver) {
    const date = (v) => v.split("-")[0];
    const [a, b] = [date(installed), date(latest)];
    if (a === b) return null; // same day, different build — no meaningful order
    return a < b;
  }
  const cmp = compareVersions(installed, latest);
  return cmp < 0;
}

/**
 * Every agent's installed version, and — only when `check` is set — the newest
 * published one and whether this machine is behind it.
 */
export async function agentVersions({ check = false } = {}) {
  return Promise.all(
    Object.entries(AGENTS).map(async ([id, spec]) => {
      const installed = normalizeVersion(await binVersion(spec.bin).catch(() => null));
      const latest = check && installed ? await latestFor(id) : null;
      return {
        id,
        bin: spec.bin,
        installed,
        latest,
        // null = we did not look, or could not tell. The UI shows nothing.
        updateAvailable: latest ? isBehind(installed, latest, { calver: spec.calver }) : null,
        // The CLI's own updater — the only thing that knows how it was installed.
        updateCommand: installed ? `${spec.bin} ${spec.update.join(" ")}` : null,
      };
    }),
  );
}

/**
 * Run an agent's own update command.
 *
 * Bounded and reported honestly: this spawns a real installer as the user, and
 * "it seemed to work" is not good enough — the version is re-read afterwards
 * from disk so the answer is what the binary now says about itself rather than
 * what the updater claimed. An updater that exits 0 and changes nothing is a
 * case that has to be visible.
 */
export async function updateAgent(id, { timeoutMs = 300_000 } = {}) {
  const spec = AGENTS[id];
  if (!spec) return { ok: false, error: "unknown agent" };
  const resolved = resolveBin(binPath(spec.bin));
  if (!resolved) return { ok: false, error: `${spec.bin} is not installed` };

  // What it was, so "ran fine and changed nothing" can be told from "updated".
  const before = normalizeVersion(await binVersion(spec.bin).catch(() => null));

  return new Promise((resolve) => {
    const child = spawn(resolved, spec.update, {
      env: agentEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let killed = false;
    const cap = (chunk) => {
      // An updater can print a progress bar for minutes; keep the tail only.
      out = `${out}${chunk}`.slice(-8000);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e?.message || e), output: out.trim() });
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      // Ask the binary what it is NOW. binVersion keys its cache on the file's
      // mtime+size, so a replaced binary re-reads rather than answering with the
      // version it had before the update.
      const installed = normalizeVersion(await binVersion(spec.bin).catch(() => null));
      resolve({
        ok: !killed && code === 0,
        code,
        timedOut: killed,
        output: out.trim(),
        before,
        installed,
        // Exit 0 is the updater's opinion; this is the disk's. An updater that
        // succeeds and changes nothing is a real case (already current, or an
        // install it has no permission to replace) and the caller has to be
        // able to tell it apart from an update that landed.
        changed: !!installed && installed !== before,
      });
    });
  });
}
