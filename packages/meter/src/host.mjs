/**
 * Host adapter — the two things a meter needs from whoever is hosting it.
 *
 * Reading an agent's spend means shelling out to that agent's CLI (`ccusage`,
 * `cursor-agent`), and finding a CLI is environment-specific in a way this
 * package deliberately does not know about: the bridge resolves it through a
 * login-shell PATH, user-pinned binary overrides and a per-platform list of
 * likely install dirs (apps/bridge/agents/env.mjs), while a headless collector
 * running as a service has none of that and just wants `process.env`.
 *
 * So the package ships defaults that work standalone, and the bridge overrides
 * them once at startup via its `agents/meter.mjs` seam. Two functions, five
 * call sites — that is the whole coupling between metering and its host, and
 * keeping it this small is what makes the package liftable into another repo.
 */

/** The neutral default: whatever environment we were started in. */
const defaults = {
  agentEnv: () => process.env,
  binPath: (name) => name,
  binOverride: () => null,
};

let host = { ...defaults };

/**
 * Point the meter at a host's own binary/environment resolution. Call once,
 * before any read — the bridge does this on import of `agents/meter.mjs`.
 *
 * @param {Partial<typeof defaults>} patch
 */
export function configureMeterHost(patch = {}) {
  host = { ...host, ...patch };
}

/** Restore the standalone defaults. Tests use this; nothing else should. */
export function resetMeterHost() {
  host = { ...defaults };
}

/** Environment (notably PATH) to spawn an agent CLI with. */
export const agentEnv = () => host.agentEnv();

/** Resolve a CLI name to the path the host wants used for it. */
export const binPath = (name) => host.binPath(name);

/** A user-pinned absolute path for a CLI, or null to search PATH. */
export const binOverride = (name) => host.binOverride(name);
