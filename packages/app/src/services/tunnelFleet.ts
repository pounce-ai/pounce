/**
 * Which tunnel every machine is running, and replacing the ones that have
 * fallen behind.
 *
 * The tunnel is the thing that makes a machine reachable off its own network,
 * and until now nothing could say what version any machine had — `doctor`
 * reported presence, and the installer only ever fetched a binary when one was
 * missing. So the first tunnel release after 0.1.0 would have left every
 * existing machine behind, silently and invisibly. This is the other half:
 * reading the fleet's versions in one place, and closing the gap on purpose.
 *
 * Two numbers per machine, and they answer different questions. `version` is
 * the release — what drifts, and what an update closes. `proto` is the ALPN,
 * which is the real interoperability boundary: iroh refuses a connection whose
 * ALPN doesn't match, so machines sharing a `proto` can talk however far their
 * releases have drifted. That's what makes a fleet updatable one machine at a
 * time instead of all at once, and why a version gap is worth showing but is
 * not, by itself, an outage.
 */
import { bridgeBase, deviceForHost, listDeviceConfigs, type DeviceConfig } from "./bridge";
import type { TunnelStatus, TunnelUpdateState, VersionSource } from "./tunnelVersions";

export { fleetDrift, versionText } from "./tunnelVersions";
export type { TunnelStatus, TunnelUpdateState, VersionSource } from "./tunnelVersions";

interface VersionBody {
  installed?: boolean;
  running?: boolean;
  version?: string | null;
  proto?: string | null;
  source?: VersionSource | null;
  latest?: string | null;
  updateAvailable?: boolean | null;
  lastUpdate?: TunnelUpdateState | null;
}

/** Carries the status so a caller can tell "it said no" from "it said what?" —
 *  a 404 here means an older bridge, not an unreachable machine. */
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(
  cfg: DeviceConfig,
  path: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<T> {
  const base = await bridgeBase(cfg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { ...init.headers, authorization: `Bearer ${cfg.token}` },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new HttpError(body?.error || `${path} -> ${res.status}`, res.status);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** One machine's tunnel. `check` costs a GitHub API call on the far side, so it
 *  is opt-in rather than part of every refresh. */
export async function readTunnel(cfg: DeviceConfig, check = false): Promise<TunnelStatus> {
  const base = {
    hostId: cfg.id,
    name: cfg.name,
    installed: false,
    running: false,
    version: null,
    proto: null,
    source: null,
    latest: null,
    updateAvailable: null,
    lastUpdate: null,
  };
  try {
    const b = await call<VersionBody>(cfg, `/v1/tunnel/version${check ? "?check=1" : ""}`);
    return {
      ...base,
      reachable: true,
      installed: !!b.installed,
      running: !!b.running,
      version: b.version ?? null,
      proto: b.proto ?? null,
      source: b.source ?? null,
      latest: b.latest ?? null,
      updateAvailable: b.updateAvailable ?? null,
      lastUpdate: b.lastUpdate ?? null,
      error: null,
    };
  } catch (e) {
    // A 404 is a bridge from before this route existed, NOT a machine that's
    // down. It answered — it just doesn't know the question. Calling that
    // "can't reach" would send someone to go check a server that is perfectly
    // healthy, and it's the state every machine is in until its bridge is
    // updated, so it is the common case rather than an edge one.
    if (e instanceof HttpError && e.status === 404) {
      return { ...base, reachable: true, bridgeTooOld: true, error: null };
    }
    // Unreachable is its OWN state, deliberately distinct from "no tunnel" and
    // from "old tunnel". A machine we couldn't ask must never be rendered as up
    // to date, and must never be counted as drift either.
    return { ...base, reachable: false, error: String((e as Error)?.message || e) };
  }
}

/**
 * Every paired machine's tunnel, asked in parallel.
 *
 * A bridge too old to have the route answers 404 and lands as unreachable with
 * an error, which is the honest rendering: we genuinely do not know what tunnel
 * it is running, and pretending otherwise is the exact failure this feature is
 * meant to end.
 */
export async function fleetTunnels(check = false): Promise<TunnelStatus[]> {
  const configs = await listDeviceConfigs();
  return Promise.all(configs.map((cfg) => readTunnel(cfg, check)));
}

/**
 * Update one machine's tunnel, and wait to find out whether it worked.
 *
 * The awkward shape here is not incidental. On a remote machine this request
 * travels over the very tunnel being replaced, so the restart drops the
 * connection: the bridge answers 202 BEFORE it touches anything, and the result
 * has to be collected afterwards by asking again. The node id survives a binary
 * swap (the identity key isn't touched), so "asking again" means re-dialling the
 * same machine — and the local proxy re-establishes itself on the next request
 * when its QUIC connection goes stale.
 *
 * Which is why the poll tolerates errors instead of treating the first one as
 * failure: a few unreachable seconds in the middle is the expected shape of a
 * success, not a sign of one going wrong.
 */
export async function updateTunnel(
  hostId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<TunnelUpdateState> {
  const cfg = await deviceForHost(hostId);
  if (!cfg) throw new Error("that machine isn't paired any more");
  const from = (await readTunnel(cfg)).version;

  await call<{ accepted?: boolean }>(cfg, "/v1/tunnel/update", { method: "POST" }).catch((e) => {
    // A dropped connection here is ambiguous — the bridge may well have
    // accepted and started. Poll before calling it a failure; only a refusal we
    // can actually read (403, 409) is worth surfacing straight away.
    const msg = String((e as Error)?.message || e);
    if (/forbidden|already running|does not own/i.test(msg)) throw e;
    return {};
  });

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  let last: TunnelUpdateState | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const status = await readTunnel(cfg);
    if (!status.reachable) continue; // mid-restart; expected
    last = status.lastUpdate;
    if (last && last.state !== "updating") return last;
    // A bridge too old to report lastUpdate still tells us the version moved.
    if (!last && status.version && status.version !== from) {
      return { state: "ok", from, to: status.version, error: null };
    }
  }
  return (
    last ?? {
      state: "failed",
      from,
      to: null,
      error: "The machine never came back to say how it went. Check it directly.",
    }
  );
}
