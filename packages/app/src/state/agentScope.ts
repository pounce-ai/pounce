/**
 * Pure agent/branch scoping helpers for the New-task and filter pickers. Kept in
 * a dependency-free leaf (only `import type`) so it's unit-testable without
 * dragging in the MMKV-backed stores. Re-exported from stores.ts for callers.
 */
import type { Device, Session } from "@pounce/shared";

/** Preferred display order for agent pickers/chips; unknown ids sort last, A→Z. */
const AGENT_ORDER = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "pi",
  "amp",
  "droid",
  "devin",
  "grok",
  "hermes",
];

export function sortAgents(ids: Iterable<string>): string[] {
  const rank = (a: string) => {
    const i = AGENT_ORDER.indexOf(a);
    return i < 0 ? AGENT_ORDER.length : i;
  };
  return [...new Set(ids)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Agents the host reports as available/usable, across devices (or one device).
 *  Sourced from `Device.agents` — what the bridge's /v1/agents filtered to
 *  `available`, i.e. installed AND (for cursor) signed in. */
export function availAgentsForDevices(devices: Device[], deviceFilter: string | null): string[] {
  const set = new Set<string>();
  for (const d of devices) {
    if (deviceFilter && d.id !== deviceFilter) continue;
    for (const a of d.agents ?? []) set.add(a);
  }
  return [...set];
}

/** Distinct branch + worktree values across `scope` (for the branch filter list). */
export function branchesInScope(scope: Session[]): string[] {
  const set = new Set<string>();
  for (const s of scope) {
    if (s.branch) set.add(s.branch);
    if (s.worktree) set.add(s.worktree);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
