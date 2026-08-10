/**
 * What a draft IS, and the two questions the UI asks about one.
 *
 * Split from ./drafts for the same reason ./sessionRules is split from
 * ./stores: the store half reaches persistence at module scope, which makes
 * anything importing it unusable from a plain unit test.
 */
import type { AgentId } from "@pounce/shared";

export interface Draft {
  readonly id: string;
  /** Everything the New screen needs to come back exactly as it was left. */
  readonly hostId: string | null;
  readonly cwd: string | null;
  readonly repoId: string | null;
  readonly agent: AgentId | null;
  readonly text: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Drafts worth showing, newest first.
 *
 * An EMPTY draft is not shown: opening the New screen creates one immediately
 * so that typing is never lost, and listing those would put a "New task" row in
 * the sidebar every time someone opened the screen and thought better of it.
 *
 * A draft earns its place by holding a DECISION — a prompt, a folder, or a
 * project. The project matters as much as the rest: starting from a space is
 * how a task gets scoped, and dropping those on the floor would mean the one
 * gesture built for "I know where this goes" was the one that didn't persist.
 */
export function listDrafts(all: Readonly<Record<string, Draft>>): Draft[] {
  return Object.values(all)
    .filter((d) => d.text.trim().length > 0 || d.cwd != null || d.repoId != null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** What the sidebar calls it: the first line of the prompt, or the folder. */
export function draftTitle(d: Draft): string {
  const line = d.text.trim().split("\n")[0]?.trim();
  if (line) return line.slice(0, 100);
  const folder = d.cwd?.replace(/\/+$/, "").split("/").pop() ?? d.repoId?.replace(/^repo:/, "");
  return folder ? `New task in ${folder}` : "New task";
}
