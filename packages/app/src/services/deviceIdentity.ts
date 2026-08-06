/**
 * Which machine is this, and have we already got it?
 *
 * A paired device used to be identified by the URL it was reached at. But an
 * address describes a network path, not a host: the same Mac is `192.168.1.3` on
 * the LAN, `127.0.0.1` from an iOS simulator, `10.0.2.2` from the Android
 * emulator, and something new again after a DHCP lease turns over. Every address
 * minted its own device, so one machine filled the device filter with copies and
 * each new address orphaned the threads synced under the last one.
 *
 * The bridge now reports a stable id for itself, so identity comes from the
 * machine rather than from how we happened to reach it. These functions are the
 * decisions; bridge.ts does the IO around them.
 */

/** The parts of a stored device config identity depends on. */
export interface DeviceIdentity {
  readonly id: string;
  readonly url: string;
  readonly token: string;
  readonly bridgeId?: string;
}

/** Identity for a paired machine. Falls back to the URL-derived form for
 *  bridges too old to name themselves, so those keep working unchanged. */
export function deviceId(url: string, bridgeId?: string | null): string {
  return bridgeId ? `dev:${bridgeId}` : `dev:${url.replace(/[^a-z0-9]/gi, "")}`;
}

export interface PairResolution<T extends DeviceIdentity> {
  /** The full config list to persist. */
  readonly configs: T[];
  /** The device the caller should connect as. */
  readonly device: T;
  /** True when this reused an existing device instead of adding a row. */
  readonly reused: boolean;
}

/**
 * Resolve a pairing against the devices already stored.
 *
 * Pairing a machine you already have — just at a new address — keeps the device
 * you know, with its threads, name and any override, and points it at the
 * address that actually reached it. Adding a row here is what used to leave the
 * filter list full of the same Mac.
 */
export function resolvePairing<T extends DeviceIdentity>(
  list: readonly T[],
  incoming: { url: string; token: string; bridgeId?: string | null; name: string },
  make: (base: DeviceIdentity & { name: string }) => T,
): PairResolution<T> {
  const url = incoming.url.replace(/\/$/, "");
  const bridgeId = incoming.bridgeId || undefined;

  const known = bridgeId ? list.find((d) => d.bridgeId === bridgeId) : undefined;
  if (known) {
    const moved = { ...known, url, token: incoming.token } as T;
    return {
      configs: [...list.filter((d) => d.id !== known.id), moved],
      device: moved,
      reused: true,
    };
  }

  const device = make({
    id: deviceId(url, bridgeId),
    url,
    token: incoming.token,
    name: incoming.name,
    ...(bridgeId ? { bridgeId } : {}),
  });
  return {
    configs: [...list.filter((d) => d.id !== device.id), device],
    device,
    reused: false,
  };
}

/**
 * Point every device at `url` at the token that bridge is actually using, and
 * report whether that changed anything — the heartbeat calls this on every
 * tick, so `changed` is what keeps it from rewriting the secure store forever.
 *
 * Every row for the address, not just the canonical one: a machine paired
 * before bridges could name themselves leaves a URL-keyed duplicate behind, and
 * leaving that on a dead token keeps it unreachable forever — which also blocks
 * the `resolveAdoption` merge that would have collapsed it, since adoption
 * needs a probe that authenticates first.
 */
export function applyBridgeToken<T extends DeviceIdentity>(
  list: readonly T[],
  url: string,
  token: string,
): { configs: T[]; changed: boolean } {
  const want = url.replace(/\/$/, "");
  let changed = false;
  const configs = list.map((d) => {
    if (d.url.replace(/\/$/, "") !== want || d.token === token) return d;
    changed = true;
    return { ...d, token } as T;
  });
  return { configs: changed ? configs : [...list], changed };
}

export interface AdoptResolution<T extends DeviceIdentity> {
  readonly configs: T[];
  /** The id everything about this machine should live under. */
  readonly survivorId: string;
  /** Device ids whose rows must be folded into `survivorId`. */
  readonly merges: string[];
}

/**
 * Settle an existing device against the identity its bridge reports.
 *
 * Devices paired before the bridge could name itself carry URL-derived ids, and
 * several of them can turn out to be one machine. The first sync that hears a
 * `bridgeId` settles it: adopt the id, fold any other config for the same
 * machine into it, and report which ids need their rows moved so nothing synced
 * under an old address is stranded.
 */
export function resolveAdoption<T extends DeviceIdentity>(
  list: readonly T[],
  cfg: T,
  bridgeId: string,
): AdoptResolution<T> {
  if (cfg.bridgeId === bridgeId) {
    return { configs: [...list], survivorId: cfg.id, merges: [] };
  }
  // Keep whichever config already owns this machine; otherwise this one becomes
  // it, under an id derived from the bridge rather than from how we reached it.
  const owner = list.find((d) => d.bridgeId === bridgeId && d.id !== cfg.id);
  const survivorId = owner?.id ?? deviceId(cfg.url, bridgeId);
  const survivor = {
    ...(owner ?? cfg),
    id: survivorId,
    bridgeId,
    url: cfg.url,
    token: cfg.token,
  } as T;

  const merges = list
    .filter((d) => d.id !== survivorId && (d.id === cfg.id || d.bridgeId === bridgeId))
    .map((d) => d.id);
  const keep = list.filter((d) => d.id !== survivorId && !merges.includes(d.id));
  return { configs: [...keep, survivor], survivorId, merges };
}
