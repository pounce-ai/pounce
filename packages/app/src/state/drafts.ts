/**
 * Drafts — a task you've started describing but haven't sent.
 *
 * Today the New screen is a modal that forgets: navigate away mid-thought and
 * the folder, the agent and the half-written prompt are gone. A draft is that
 * same state, kept — it survives a restart and shows in the sidebar, so a task
 * you're not ready to start is a thing you can park rather than something you
 * have to hold in your head.
 *
 * LOCAL, not bridge-owned, which is the opposite call from settled threads and
 * deliberate: a draft has no thread yet and may have no MACHINE yet, so there
 * is nothing to own it remotely until it's sent. (T3 Code keeps its composer
 * drafts client-side for the same reason.) The cost is that a draft started on
 * the phone doesn't appear on the desktop; the alternative is asking the user
 * to pick a machine before they're allowed to start typing.
 *
 * A draft is NOT a thread. It never enters the thread collections, so nothing
 * that syncs, counts or prices threads has to learn about it — and a draft can
 * never be mistaken for work an agent actually did.
 */
import { observable } from "@legendapp/state";
import { persist } from "../services/persistence";
import type { Draft } from "./draftRules";

export { draftTitle, listDrafts, type Draft } from "./draftRules";

export const drafts$ = observable<Record<string, Draft>>({});
persist(drafts$, "pounce.drafts");

/** `draft_` rather than `new_`: the optimistic-send placeholder in ./stores
 *  already owns that prefix, and these two must never be confused — one is a
 *  thread being born, the other is a thread that may never exist. */
const nextId = () => `draft_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Start one. Everything is optional — a draft's whole job is to hold an
 *  incomplete answer. */
export function newDraft(seed: Partial<Omit<Draft, "id" | "createdAt" | "updatedAt">> = {}): Draft {
  const now = new Date().toISOString();
  const draft: Draft = {
    id: nextId(),
    hostId: seed.hostId ?? null,
    cwd: seed.cwd ?? null,
    repoId: seed.repoId ?? null,
    agent: seed.agent ?? null,
    text: seed.text ?? "",
    createdAt: now,
    updatedAt: now,
  };
  drafts$[draft.id].set(draft);
  return draft;
}

export function updateDraft(id: string, patch: Partial<Draft>): void {
  const cur = drafts$[id].peek();
  if (!cur) return;
  drafts$[id].set({ ...cur, ...patch, updatedAt: new Date().toISOString() });
}

/** Drop a draft — on send (it has become a real thread) or on discard. */
export function removeDraft(id: string): void {
  drafts$[id].delete();
}
