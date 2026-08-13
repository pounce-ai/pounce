/**
 * Reading a fleet's tunnel versions — the judgement calls, with no transport
 * attached.
 *
 * Split from tunnelFleet.ts so it can be tested directly: the interesting part
 * of "are my machines in sync?" is not the HTTP, it's what counts as agreement.
 * A machine we couldn't reach agrees with nothing and disagrees with nothing,
 * and getting that wrong in either direction is how a fleet view lies — either
 * reporting calm while a server sits three versions back, or crying drift every
 * time a laptop's lid is shut.
 */

/** How we know a machine's version. `stamp` is a binary too old to answer for
 *  itself (`version` arrived in tunnel 0.2.0); `unknown` is one we have but
 *  cannot identify at all. */
export type VersionSource = "binary" | "stamp" | "unknown";

export interface TunnelUpdateState {
  readonly state: "updating" | "ok" | "rolled-back" | "failed";
  readonly from: string | null;
  readonly to: string | null;
  readonly error: string | null;
}

export interface TunnelStatus {
  readonly hostId: string;
  readonly name: string;
  /** False when we couldn't ask. Distinct from "asked, and it has no tunnel". */
  readonly reachable: boolean;
  readonly installed: boolean;
  readonly running: boolean;
  readonly version: string | null;
  readonly proto: string | null;
  readonly source: VersionSource | null;
  readonly latest: string | null;
  readonly updateAvailable: boolean | null;
  readonly lastUpdate: TunnelUpdateState | null;
  readonly error: string | null;
}

export interface FleetDrift {
  /** True when every machine we could actually ask agrees. */
  readonly inSync: boolean;
  /** The distinct versions in play, oldest-looking first. */
  readonly versions: string[];
  /** Machines we couldn't ask, or that couldn't say. Not drift — just unknown. */
  readonly unknown: number;
  /** Machines that could be moved forward right now. */
  readonly updatable: number;
}

/**
 * Summarise the fleet.
 *
 * Only machines that answered with a version get a vote. An unreachable one is
 * counted as unknown and nothing more: calling it drift would light the warning
 * up permanently for anyone with a laptop that sleeps, and calling it agreement
 * would report "all in sync" for a fleet nobody has heard from.
 */
export function fleetDrift(statuses: readonly TunnelStatus[]): FleetDrift {
  const known = statuses.filter((s) => s.reachable && s.version);
  const versions = [...new Set(known.map((s) => s.version as string))].sort();
  return {
    inSync: versions.length <= 1,
    versions,
    unknown: statuses.length - known.length,
    updatable: statuses.filter((s) => s.updateAvailable === true).length,
  };
}

/**
 * The version cell for one machine.
 *
 * Every branch is a state the fleet can really be in, and collapsing any of
 * them into a version number would be a claim we can't support — "up to date"
 * for a machine that never answered is exactly the lie this feature exists to
 * stop telling.
 */
export function versionText(t: TunnelStatus): string {
  if (!t.reachable) return "Can't reach";
  if (!t.installed) return "No tunnel — LAN only";
  if (!t.version) return "Unknown version";
  // Marked, because it is a weaker claim: the binary didn't say so, we did,
  // when we installed it.
  return t.source === "stamp" ? `${t.version} (recorded)` : t.version;
}
