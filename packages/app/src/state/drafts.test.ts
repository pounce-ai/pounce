/**
 * What earns a place in the sidebar, and what a draft is called.
 *
 * The listing rule is the load-bearing one: the New screen creates a draft the
 * moment it opens so typing is never lost, so without a filter every visit
 * would leave a "New task" row behind.
 */
import { describe, expect, it } from "vitest";
import type { Draft } from "./draftRules";
import { draftTitle, listDrafts } from "./draftRules";

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: "draft_1",
  hostId: null,
  cwd: null,
  repoId: null,
  agent: null,
  text: "",
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
  ...over,
});

describe("which drafts are listed", () => {
  it("skips one that holds nothing", () => {
    expect(listDrafts({ a: draft() })).toEqual([]);
  });

  it("keeps one with a prompt", () => {
    expect(listDrafts({ a: draft({ text: "fix the thing" }) })).toHaveLength(1);
  });

  it("keeps one that has at least chosen a folder", () => {
    // Picking where the work happens is a decision worth not losing, even
    // before a word is typed.
    expect(listDrafts({ a: draft({ cwd: "/Users/x/repo" }) })).toHaveLength(1);
  });

  it("keeps one started from a project, before a word is typed", () => {
    // The per-space compose gesture sets a repo and nothing else; dropping it
    // would make the one entry point built for "I know where this goes" the
    // only one that doesn't survive.
    expect(listDrafts({ a: draft({ repoId: "repo:pounce" }) })).toHaveLength(1);
  });

  it("treats whitespace as nothing", () => {
    expect(listDrafts({ a: draft({ text: "   \n  " }) })).toEqual([]);
  });

  it("puts the most recently touched first", () => {
    const out = listDrafts({
      old: draft({ id: "old", text: "a", updatedAt: "2026-08-10T09:00:00.000Z" }),
      new: draft({ id: "new", text: "b", updatedAt: "2026-08-10T11:00:00.000Z" }),
    });
    expect(out.map((d) => d.id)).toEqual(["new", "old"]);
  });
});

describe("what a draft is called", () => {
  it("uses the first line of the prompt", () => {
    expect(draftTitle(draft({ text: "Add a settings page\nand wire it up" }))).toBe(
      "Add a settings page",
    );
  });

  it("falls back to the folder when nothing is typed", () => {
    expect(draftTitle(draft({ cwd: "/Users/x/Projects/pounce" }))).toBe("New task in pounce");
  });

  it("names one by its project when that is all it has", () => {
    expect(draftTitle(draft({ repoId: "repo:pounce-mono" }))).toBe("New task in pounce-mono");
  });

  it("has a name even when it holds nothing at all", () => {
    expect(draftTitle(draft())).toBe("New task");
  });

  it("does not run away with a long prompt", () => {
    expect(draftTitle(draft({ text: "x".repeat(400) })).length).toBe(100);
  });
});
