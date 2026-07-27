import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readContextFiles } from "./context.mjs";

const roots = [];
function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pounce-ctx-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("readContextFiles", () => {
  it("reads the whitelisted files that exist and ignores everything else", () => {
    const dir = repo();
    writeFileSync(path.join(dir, "CLAUDE.md"), "# Project\n\nBe careful.\n");
    writeFileSync(path.join(dir, "AGENTS.md"), "agents\n");
    writeFileSync(path.join(dir, "README.md"), "not context\n");
    writeFileSync(path.join(dir, ".env"), "SECRET=1\n");

    const out = readContextFiles(dir);
    expect(out.files.map((f) => f.path)).toEqual(["CLAUDE.md", "AGENTS.md"]);
    expect(out.files[0].content).toContain("Be careful.");
    expect(out.files[0].truncated).toBe(false);
  });

  it("finds the nested .claude/CLAUDE.md and reports a forward-slashed path", () => {
    const dir = repo();
    mkdirSync(path.join(dir, ".claude"));
    writeFileSync(path.join(dir, ".claude", "CLAUDE.md"), "nested\n");

    const out = readContextFiles(dir);
    // Forward slashes even though the host may use path.sep — the app shows
    // this verbatim as the file's identity.
    expect(out.files.map((f) => f.path)).toEqual([".claude/CLAUDE.md"]);
  });

  it("returns an empty list for a project with no context files", () => {
    const out = readContextFiles(repo());
    expect(out.files).toEqual([]);
  });

  it("returns null for a path that isn't a directory", () => {
    const dir = repo();
    const file = path.join(dir, "CLAUDE.md");
    writeFileSync(file, "x\n");
    expect(readContextFiles(file)).toBeNull();
    expect(readContextFiles(path.join(dir, "nope"))).toBeNull();
  });

  it("refuses a whitelisted name that symlinks outside the project", () => {
    const outside = repo();
    const secret = path.join(outside, "id_rsa");
    writeFileSync(secret, "PRIVATE KEY\n");
    const dir = repo();
    // The one way a fixed whitelist could still read arbitrary files: put the
    // approved NAME in the repo but point it somewhere else.
    symlinkSync(secret, path.join(dir, "CLAUDE.md"));

    const out = readContextFiles(dir);
    expect(out.files).toEqual([]);
  });

  it("follows a symlink that stays inside the project", () => {
    const dir = repo();
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "instructions.md"), "shared\n");
    symlinkSync(path.join(dir, "docs", "instructions.md"), path.join(dir, "AGENTS.md"));

    const out = readContextFiles(dir);
    expect(out.files.map((f) => f.path)).toEqual(["AGENTS.md"]);
    expect(out.files[0].content).toBe("shared\n");
  });

  it("truncates a file past the per-file cap and flags it", () => {
    const dir = repo();
    writeFileSync(path.join(dir, "CLAUDE.md"), "x".repeat(300 * 1024));

    const [file] = readContextFiles(dir).files;
    expect(file.truncated).toBe(true);
    expect(file.content.length).toBe(256 * 1024);
    // `size` stays the file's real size — the app tells the user what it cut.
    expect(file.size).toBe(300 * 1024);
  });
});
