/**
 * A Space is one repository on one machine — `comet-native @ work-laptop`.
 *
 * It is the unit people actually navigate by: the same repo checked out on a
 * laptop and on a build box are two different places to work, with different
 * worktrees and different live agents, even though they share a name. Nothing
 * persists a Space, so they're derived from the sessions that exist.
 */
import type { Session } from "@pounce/shared";

export interface Space {
  /** repoId + hostId — stable across re-derivations, unlike a list index. */
  readonly key: string;
  readonly repoId: string;
  /** The bridge's own repo key (repoId without the `repo:` prefix) — what the
   *  host wants when asked to scope anything to this project. */
  readonly repoKey: string;
  readonly hostId: string;
  readonly name: string;
  readonly host: string;
  readonly sessionCount: number;
  /** Sessions whose worktree still exists — the ones you can steer. */
  readonly liveCount: number;
  /** An agent is working here right now. */
  readonly live: boolean;
  /** Sessions in this space waiting on the user. */
  readonly attention: number;
  /** Agent ids seen in this space, busiest first. */
  readonly agents: readonly string[];
  /**
   * Working directories this space has been worked in, repo root first.
   *
   * A Space is one repo, but a repo has one checkout and N worktrees, each with
   * its own files on disk — so "the project's CLAUDE.md" is a question about a
   * directory, not about the space. Root leads because that's where the
   * committed context lives; the rest are offered as alternatives.
   */
  readonly cwds: readonly string[];
  readonly firstActivityAt: string;
  readonly lastActivityAt: string;
}

export function spaceKeyOf(s: Session): string {
  return `${s.repoId} ${s.hostId}`;
}

/** Working directories for a space's sessions, repo root before worktrees and
 *  newest-touched first within each — the same ordering the Context screen
 *  uses, so the two agree on which checkout is "the project". */
function cwdsOf(list: readonly Session[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const sorted = [...list].sort((a, b) => {
    if (!!a.worktree !== !!b.worktree) return a.worktree ? 1 : -1;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
  for (const s of sorted) {
    if (!s.cwd || seen.has(s.cwd)) continue;
    seen.add(s.cwd);
    out.push(s.cwd);
  }
  return out;
}

/** Agent ids in a space, most sessions first. */
function agentsOf(list: readonly Session[]): string[] {
  const counts = new Map<string, number>();
  for (const s of list) counts.set(s.agent, (counts.get(s.agent) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([agent]) => agent);
}

/**
 * Group sessions into Spaces, most-recently-active first. `repoName` resolves a
 * repoId to its display name (the projects collection); it falls back to the
 * bare id so a space still renders while projects are syncing.
 */
export function deriveSpaces(
  sessions: readonly Session[],
  repoName: (repoId: string) => string,
  needsYou: (s: Session) => boolean,
): Space[] {
  const byKey = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = spaceKeyOf(s);
    const arr = byKey.get(key);
    if (arr) arr.push(s);
    else byKey.set(key, [s]);
  }

  const spaces: Space[] = [];
  for (const [key, list] of byKey) {
    const head = list[0];
    spaces.push({
      key,
      repoId: head.repoId,
      repoKey: head.repoId.replace(/^repo:/, ""),
      hostId: head.hostId,
      name: repoName(head.repoId),
      host: head.host,
      sessionCount: list.length,
      liveCount: list.filter((s) => s.isLive).length,
      live: list.some((s) => s.activity === "running" || s.activity === "streaming"),
      attention: list.filter(needsYou).length,
      agents: agentsOf(list),
      cwds: cwdsOf(list),
      firstActivityAt: list.reduce(
        (min, s) => (Date.parse(s.createdAt) < Date.parse(min) ? s.createdAt : min),
        head.createdAt,
      ),
      lastActivityAt: list.reduce(
        (max, s) => (Date.parse(s.updatedAt) > Date.parse(max) ? s.updatedAt : max),
        head.updatedAt,
      ),
    });
  }
  // Spaces needing you float up, then live ones, then by recency — the same
  // ranking the session list uses, so the two halves of the sidebar agree.
  return spaces.sort(
    (a, b) =>
      Number(b.attention > 0) - Number(a.attention > 0) ||
      Number(b.live) - Number(a.live) ||
      Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
}
