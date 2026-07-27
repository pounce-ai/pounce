/**
 * Review notes the user has left on a project's context files, waiting to be
 * sent to an agent.
 *
 * Persisted, because writing them is the slow part: a note gets typed on a
 * phone, the app gets backgrounded, and losing the queue would mean retyping.
 * They're cleared when the user hands them to a thread — at that point the
 * prompt carries them and the queue's job is done.
 *
 * Keyed by `hostId|cwd` rather than by repo: the same repo checked out on two
 * machines (or in two worktrees) has its own files and its own notes.
 */
import { observable } from "@legendapp/state";
import { persist } from "../services/persistence";
import type { ContextComment } from "../components/contextSections";

export type { ContextComment };

export const contextComments$ = observable<Record<string, ContextComment[]>>({});

/** Store key for a project on a host. */
export function contextKey(hostId: string, cwd: string): string {
  return `${hostId}|${cwd}`;
}

export function addContextComment(
  hostId: string,
  cwd: string,
  comment: Omit<ContextComment, "id" | "createdAt">,
): void {
  const key = contextKey(hostId, cwd);
  const cur = contextComments$[key].get() ?? [];
  contextComments$[key].set([
    ...cur,
    { ...comment, id: `cc_${Date.now()}_${cur.length}`, createdAt: new Date().toISOString() },
  ]);
}

export function removeContextComment(hostId: string, cwd: string, id: string): void {
  const key = contextKey(hostId, cwd);
  const cur = contextComments$[key].get() ?? [];
  const next = cur.filter((c) => c.id !== id);
  if (next.length) contextComments$[key].set(next);
  else contextComments$[key].delete();
}

export function clearContextComments(hostId: string, cwd: string): void {
  contextComments$[contextKey(hostId, cwd)].delete();
}

/**
 * The change request handed to the New-task screen, in memory only.
 *
 * Transient on purpose (the pattern `pendingTurns$` uses): it exists for the
 * one hop from "Request changes" to the composer. Persisting it would mean a
 * relaunch days later silently pre-fills a composer with a forgotten draft.
 */
export const contextDraft$ = observable<string | null>(null);

persist(contextComments$, "contextComments");
