/**
 * `upsertRows` skips writes that would not change the row. That skip is
 * load-bearing in two directions: too eager and the sync silently stops
 * applying real updates; too shy and every tick wakes every `useLiveQuery` and
 * re-renders every mounted screen (which is what it used to do — ~5,100 fiber
 * renders per 30s while idle).
 */
import { describe, expect, it } from "vitest";
import { upsertRows } from "./rowWrites";

type Row = { id: string } & Record<string, unknown>;

/** Minimal stand-in for the collection API `upsertRows` uses, recording every
 *  write so a test can assert on what actually reached the store. */
function fakeCollection(initial: Row[] = []) {
  const rows = new Map<string, Row>(initial.map((r) => [r.id, structuredClone(r)]));
  const updated: string[] = [];
  const inserted: string[] = [];
  return {
    rows,
    updated,
    inserted,
    has: (id: string) => rows.has(id),
    get: (id: string) => rows.get(id),
    insert: (batch: Row[]) => {
      for (const r of batch) {
        rows.set(r.id, structuredClone(r));
        inserted.push(r.id);
      }
    },
    update: (id: string, fn: (draft: Row) => void) => {
      const draft = rows.get(id)!;
      fn(draft);
      updated.push(id);
    },
    delete: () => {},
    keys: () => rows.keys(),
  };
}

describe("upsertRows", () => {
  it("inserts rows it has never seen", () => {
    const c = fakeCollection();
    upsertRows(c, [{ id: "a", name: "one" }]);
    expect(c.inserted).toEqual(["a"]);
    expect(c.rows.get("a")).toMatchObject({ name: "one" });
  });

  it("skips a row that is byte-identical", () => {
    const c = fakeCollection([{ id: "a", name: "one", nested: { x: 1 }, list: [1, 2] }]);
    upsertRows(c, [{ id: "a", name: "one", nested: { x: 1 }, list: [1, 2] }]);
    expect(c.updated).toEqual([]);
  });

  it("writes when a top-level field changes", () => {
    const c = fakeCollection([{ id: "a", lastSyncAt: "1" }]);
    upsertRows(c, [{ id: "a", lastSyncAt: "2" }]);
    expect(c.updated).toEqual(["a"]);
    expect(c.rows.get("a")).toMatchObject({ lastSyncAt: "2" });
  });

  it("writes when a NESTED field changes", () => {
    const c = fakeCollection([{ id: "a", usage: { tokens: 1, cacheRead: 0 } }]);
    upsertRows(c, [{ id: "a", usage: { tokens: 2, cacheRead: 0 } }]);
    expect(c.updated).toEqual(["a"]);
    expect(c.rows.get("a")).toMatchObject({ usage: { tokens: 2 } });
  });

  it("writes when an array element changes, and when its length changes", () => {
    const c = fakeCollection([{ id: "a", tags: ["x", "y"] }]);
    upsertRows(c, [{ id: "a", tags: ["x", "z"] }]);
    expect(c.updated).toEqual(["a"]);
    upsertRows(c, [{ id: "a", tags: ["x", "z", "w"] }]);
    expect(c.updated).toEqual(["a", "a"]);
  });

  it("writes when the row gains a field it did not have", () => {
    const c = fakeCollection([{ id: "a", name: "one" }]);
    upsertRows(c, [{ id: "a", name: "one", extra: true }]);
    expect(c.updated).toEqual(["a"]);
  });

  it("ignores fields the incoming row omits — assign merges, it does not clear", () => {
    // The draft carries a locally-derived field the sync payload never sends.
    // Treating its absence as a difference would rewrite the row every tick.
    const c = fakeCollection([{ id: "a", name: "one", localOnly: 42 }]);
    upsertRows(c, [{ id: "a", name: "one" }]);
    expect(c.updated).toEqual([]);
    expect(c.rows.get("a")).toMatchObject({ localOnly: 42 });
  });

  it("distinguishes null from undefined and from a missing value", () => {
    const c = fakeCollection([{ id: "a", v: null }]);
    upsertRows(c, [{ id: "a", v: undefined }]);
    expect(c.updated).toEqual(["a"]);
  });

  it("does not treat 0 / '' / false as equal to each other", () => {
    const c = fakeCollection([{ id: "a", v: 0 }]);
    upsertRows(c, [{ id: "a", v: false }]);
    expect(c.updated).toEqual(["a"]);
  });

  it("mixes inserts and skips in one batch", () => {
    const c = fakeCollection([{ id: "a", n: 1 }]);
    upsertRows(c, [
      { id: "a", n: 1 }, // unchanged → skipped
      { id: "b", n: 2 }, // new → inserted
    ]);
    expect(c.updated).toEqual([]);
    expect(c.inserted).toEqual(["b"]);
  });

  it("still collapses duplicate ids within one batch (last write wins)", () => {
    const c = fakeCollection();
    upsertRows(c, [
      { id: "a", n: 1 },
      { id: "a", n: 2 },
    ]);
    expect(c.inserted).toEqual(["a"]);
    expect(c.rows.get("a")).toMatchObject({ n: 2 });
  });
});
