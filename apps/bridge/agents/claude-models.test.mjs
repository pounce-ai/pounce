/**
 * Claude model catalog — discovered, never hardcoded.
 *
 * The list this replaced was four pinned ids, and it rotted exactly the way
 * codex.mjs's did: it still named Opus 4.8 as the default long after Opus 5 was
 * the model every thread ran on, so a thread could not be switched back onto a
 * model the account used daily. These tests pin the three real sources.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// listModels() reads two fixed config paths under $HOME. Override just those
// reads (by filename) so the tests don't depend on the dev machine's own
// Claude Code install; every other read falls through to the real fs.
const stub = vi.hoisted(() => ({ files: new Map() }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal();
  const readFileSync = (p, ...rest) => {
    for (const [suffix, content] of stub.files) {
      if (String(p).endsWith(suffix)) {
        if (content == null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return content;
      }
    }
    return real.readFileSync(p, ...rest);
  };
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});

const { ClaudeAdapter } = await import("./claude.mjs");

const NONE = () => {
  stub.files.set(".claude/settings.json", null);
  stub.files.set(".claude.json", null);
};

/** An adapter whose session index serves the given transcripts, newest first.
 *  Each entry is a list of raw JSONL records for one thread, or
 *  `{ records, updatedAt }` to place that thread at a point in time. */
function adapterFor(transcripts = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-models-"));
  const metas = transcripts.map((t, i) => {
    const { records, updatedAt } = Array.isArray(t) ? { records: t } : t;
    const filePath = path.join(dir, `t${i}.jsonl`);
    writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n"));
    return updatedAt ? { filePath, updatedAt } : { filePath };
  });
  const a = new ClaudeAdapter({ turns: { isRunning: () => false } });
  a.index = { list: async () => metas };
  return { a, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const said = (model) => ({ type: "assistant", message: { model, content: [] } });

async function models(transcripts) {
  const { a, cleanup } = adapterFor(transcripts);
  try {
    return await a.listModels();
  } finally {
    cleanup();
  }
}

describe("claude listModels", () => {
  it("offers models the machine has actually run, newest thread first", async () => {
    NONE();
    const got = await models([[said("claude-opus-5")], [said("claude-fable-5")]]);
    const ids = got.map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(["claude-opus-5", "claude-fable-5"]);
    expect(got[0].name).toBe("Opus 5");
  });

  it("takes each thread's LAST model, not its first", async () => {
    NONE();
    // A thread that was switched mid-way reports where it ended up.
    const got = await models([[said("claude-opus-4-8"), said("claude-opus-5")]]);
    expect(got[0].id).toBe("claude-opus-5");
  });

  it("never offers <synthetic>, which is not a model", async () => {
    NONE();
    const got = await models([[said("<synthetic>"), said("claude-opus-5")]]);
    expect(got.map((m) => m.id)).not.toContain("<synthetic>");
    expect(got.map((m) => m.id)).toContain("claude-opus-5");
  });

  it("always offers the family aliases, which cannot go stale", async () => {
    NONE();
    const ids = (await models([])).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["opus", "fable", "sonnet", "haiku"]));
  });

  it("includes the CLI's own cached extra options, with the server's label", async () => {
    NONE();
    stub.files.set(
      ".claude.json",
      JSON.stringify({
        additionalModelOptionsCache: [
          { value: "claude-fable-5[1m]", label: "Fable", description: "1M context" },
        ],
      }),
    );
    const got = await models([]);
    const m = got.find((x) => x.id === "claude-fable-5[1m]");
    expect(m).toMatchObject({ name: "Fable", description: "1M context" });
  });

  it("marks default from Claude Code's settings, and only from there", async () => {
    NONE();
    const none = await models([[said("claude-opus-5")]]);
    expect(none.some((m) => m.isDefault)).toBe(false); // nothing configured → no claim

    stub.files.set(".claude/settings.json", JSON.stringify({ model: "claude-opus-5" }));
    const got = await models([[said("claude-opus-5")]]);
    expect(got.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  it("offers a configured model the transcripts have never seen", async () => {
    NONE();
    stub.files.set(".claude/settings.json", JSON.stringify({ model: "claude-mythos-5" }));
    const got = await models([]);
    expect(got.find((m) => m.id === "claude-mythos-5")).toMatchObject({
      name: "Mythos 5",
      isDefault: true,
    });
  });

  it("retires a model a newer one in its family has replaced, without dropping it", async () => {
    NONE();
    const got = await models([[said("claude-opus-5")], [said("claude-opus-4-8")]]);
    const byId = Object.fromEntries(got.map((m) => [m.id, m]));
    // Still selectable — a thread that ran on it has to be able to go back...
    expect(byId["claude-opus-4-8"]).toBeTruthy();
    expect(byId["claude-opus-4-8"].deprecated).toBe(true);
    expect(byId["claude-opus-5"].deprecated).toBe(false);
    // ...but never above a current model.
    const ids = got.map((m) => m.id);
    expect(ids.indexOf("claude-opus-5")).toBeLessThan(ids.indexOf("claude-opus-4-8"));
  });

  it("retires only within a family, and never an alias", async () => {
    NONE();
    const got = await models([[said("claude-opus-5")], [said("claude-haiku-4-5-20251001")]]);
    const dead = got.filter((m) => m.deprecated).map((m) => m.id);
    // Opus 5 does not supersede Haiku 4.5 — different families, both current.
    expect(dead).toEqual([]);
    expect(got.find((m) => m.id === "opus").deprecated).toBe(false);
  });

  it("treats a context variant as its own family, not a superseded sibling", async () => {
    NONE();
    stub.files.set(
      ".claude.json",
      JSON.stringify({
        additionalModelOptionsCache: [{ value: "claude-fable-5[1m]", label: "Fable" }],
      }),
    );
    const got = await models([[said("claude-fable-5")]]);
    expect(got.filter((m) => m.deprecated).map((m) => m.id)).toEqual([]);
  });

  it("counts a dated snapshot as the same version as its undated name", async () => {
    NONE();
    const got = await models([[said("claude-haiku-4-5-20251001")], [said("claude-haiku-4-5")]]);
    expect(got.filter((m) => m.deprecated).map((m) => m.id)).toEqual([]);
  });

  it("stops offering models from threads nobody has touched in a month", async () => {
    NONE();
    const day = 24 * 60 * 60_000;
    const at = (d) => new Date(Date.now() - d * day).toISOString();
    const ids = (
      await models([
        { records: [said("claude-opus-5")], updatedAt: at(1) },
        { records: [said("claude-opus-4-8")], updatedAt: at(90) },
      ])
    ).map((m) => m.id);
    expect(ids).toContain("claude-opus-5");
    // Ninety days cold is not "a model this machine runs" — the aliases cover it.
    expect(ids).not.toContain("claude-opus-4-8");
  });

  it("changes signature when the configured model changes, and not otherwise", async () => {
    NONE();
    const { a, cleanup } = adapterFor([]);
    try {
      const before = a.modelsSignature();
      expect(a.modelsSignature()).toBe(before);
      stub.files.set(".claude/settings.json", JSON.stringify({ model: "claude-opus-5" }));
      expect(a.modelsSignature()).not.toBe(before);
    } finally {
      cleanup();
    }
  });

  it("survives a machine with no Claude state at all", async () => {
    NONE();
    const { a, cleanup } = adapterFor([]);
    a.index = {
      list: async () => {
        throw new Error("no index");
      },
    };
    try {
      const got = await a.listModels();
      expect(got.map((m) => m.id)).toEqual(["opus", "fable", "sonnet", "haiku"]);
    } finally {
      cleanup();
    }
  });
});
