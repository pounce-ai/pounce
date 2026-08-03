import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// db.mjs and store.mjs both resolve ~/.pounce at import time, so HOME must point
// at a scratch dir before either is imported.
const tmp = mkdtempSync(path.join(os.tmpdir(), "pounce-markers-"));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;

const { Store } = await import("./store.mjs");
const { openDb } = await import("./db.mjs");
const { setMarker, listMarkers, clearThreadMarkers, replaceThreadMarkers, backend, _fallback } =
  await import("./markers.mjs");

const db = openDb();

beforeEach(async () => {
  if (db) db.exec("DELETE FROM markers");
  _fallback.rows.clear();
  _fallback._loaded = true;
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("markers", () => {
  it("reports which backend is live", async () => {
    expect(["bun:sqlite", "node:sqlite", "json"]).toContain(await backend());
  });

  it("stores an override and reads it back", async () => {
    await setMarker("t1", "e1", true);
    expect(await listMarkers("t1")).toEqual([{ threadId: "t1", eventId: "e1", marked: true }]);
  });

  it("stores a false override — unmarking a default-marked event is real data", async () => {
    await setMarker("t1", "e1", false);
    const rows = await listMarkers("t1");
    expect(rows[0].marked).toBe(false);
  });

  it("re-setting the same event updates rather than duplicating", async () => {
    await setMarker("t1", "e1", true);
    await setMarker("t1", "e1", false);
    const rows = await listMarkers("t1");
    expect(rows).toHaveLength(1);
    expect(rows[0].marked).toBe(false);
  });

  it("null clears the override so the computed default applies again", async () => {
    await setMarker("t1", "e1", true);
    await setMarker("t1", "e1", null);
    expect(await listMarkers("t1")).toEqual([]);
  });

  it("scopes by thread", async () => {
    await setMarker("t1", "e1", true);
    await setMarker("t2", "e1", true);
    expect(await listMarkers("t1")).toHaveLength(1);
    expect(await listMarkers()).toHaveLength(2);
  });

  it("does not confuse threads sharing an id prefix", async () => {
    await setMarker("t1", "e1", true);
    await setMarker("t10", "e1", true);
    expect(await listMarkers("t1")).toEqual([{ threadId: "t1", eventId: "e1", marked: true }]);
  });

  it("keeps event ids containing the separator intact", async () => {
    await setMarker("t1", "a|b|c", true);
    expect(await listMarkers("t1")).toEqual([{ threadId: "t1", eventId: "a|b|c", marked: true }]);
  });

  it("clearThreadMarkers drops only that thread and reports the count", async () => {
    await setMarker("t1", "e1", true);
    await setMarker("t1", "e2", true);
    await setMarker("t2", "e1", true);
    expect(await clearThreadMarkers("t1")).toBe(2);
    expect(await listMarkers()).toEqual([{ threadId: "t2", eventId: "e1", marked: true }]);
  });

  it("replaceThreadMarkers is idempotent and replaces wholesale", async () => {
    await replaceThreadMarkers("t1", [
      { eventId: "a", marked: true },
      { eventId: "b", marked: false },
    ]);
    expect(await listMarkers("t1")).toHaveLength(2);
    await replaceThreadMarkers("t1", [{ eventId: "c", marked: true }]);
    expect(await listMarkers("t1")).toEqual([{ threadId: "t1", eventId: "c", marked: true }]);
  });

  it("replaceThreadMarkers leaves other threads alone", async () => {
    await setMarker("keep", "e1", true);
    await replaceThreadMarkers("t1", [{ eventId: "a", marked: true }]);
    expect(await listMarkers("keep")).toHaveLength(1);
  });

  it("ignores incomplete input rather than storing junk keys", async () => {
    expect(await setMarker("", "e1", true)).toBe(false);
    expect(await setMarker("t1", "", true)).toBe(false);
    expect(await listMarkers()).toEqual([]);
  });
});

// The JSON path is what runs wherever Turso publishes no prebuild (Intel Macs,
// musl). It has to behave identically, so it gets the same assertions.
describe("markers — JSON fallback backend", () => {
  const viaFallback = {
    set: (t, e, m) => {
      const key = `${t}|${e}`;
      if (m === null) return _fallback.delete(key);
      _fallback.set(key, { marked: !!m, updatedAt: new Date().toISOString() });
      return true;
    },
    list: (t) =>
      Object.entries(t ? _fallback.withPrefix(`${t}|`) : _fallback.all()).map(([k, v]) => {
        const i = k.indexOf("|");
        return { threadId: k.slice(0, i), eventId: k.slice(i + 1), marked: !!v.marked };
      }),
  };

  it("round-trips an override", () => {
    viaFallback.set("t1", "e1", true);
    expect(viaFallback.list("t1")).toEqual([{ threadId: "t1", eventId: "e1", marked: true }]);
  });

  it("null clears", () => {
    viaFallback.set("t1", "e1", true);
    viaFallback.set("t1", "e1", null);
    expect(viaFallback.list("t1")).toEqual([]);
  });

  it("keeps separator-bearing event ids intact", () => {
    viaFallback.set("t1", "a|b|c", true);
    expect(viaFallback.list("t1")).toEqual([{ threadId: "t1", eventId: "a|b|c", marked: true }]);
  });
});

describe("Store", () => {
  it("round-trips through disk", () => {
    const a = new Store("roundtrip");
    a.set("k", { v: 1 });
    a.flush();
    expect(new Store("roundtrip").get("k")).toEqual({ v: 1 });
  });

  it("survives a corrupt file instead of throwing", () => {
    const s = new Store("corrupt");
    s.set("k", 1);
    s.flush();
    writeFileSync(s.file, "{not json");
    const fresh = new Store("corrupt");
    expect(fresh.all()).toEqual({});
    expect(() => fresh.set("k2", 2)).not.toThrow();
  });

  it("deletePrefix removes matching keys and reports the count", () => {
    const s = new Store("prefix");
    s.set("a|1", 1);
    s.set("a|2", 1);
    s.set("b|1", 1);
    expect(s.deletePrefix("a|")).toBe(2);
    expect(Object.keys(s.all())).toEqual(["b|1"]);
  });

  it("writes atomically — no .tmp file is left behind", () => {
    const s = new Store("atomic");
    s.set("k", 1);
    s.flush();
    expect(existsSync(s.file)).toBe(true);
    expect(existsSync(`${s.file}.${process.pid}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(s.file, "utf8")).v).toBe(1);
  });
});
