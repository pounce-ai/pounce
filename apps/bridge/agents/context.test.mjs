import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readContextFiles, writeContextFile } from "./context.mjs";

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
  it("reads the whitelisted files that exist and ignores everything else", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "CLAUDE.md"), "# Project\n\nBe careful.\n");
    writeFileSync(path.join(dir, "AGENTS.md"), "agents\n");
    writeFileSync(path.join(dir, "README.md"), "not context\n");
    writeFileSync(path.join(dir, ".env"), "SECRET=1\n");

    const out = await readContextFiles(dir);
    expect(out.files.map((f) => f.path)).toEqual(["CLAUDE.md", "AGENTS.md"]);
    expect(out.files[0].content).toContain("Be careful.");
    expect(out.files[0].truncated).toBe(false);
  });

  it("finds the nested .claude/CLAUDE.md and reports a forward-slashed path", async () => {
    const dir = repo();
    mkdirSync(path.join(dir, ".claude"));
    writeFileSync(path.join(dir, ".claude", "CLAUDE.md"), "nested\n");

    const out = await readContextFiles(dir);
    // Forward slashes even though the host may use path.sep — the app shows
    // this verbatim as the file's identity.
    expect(out.files.map((f) => f.path)).toEqual([".claude/CLAUDE.md"]);
  });

  it("returns an empty list for a project with no context files", async () => {
    const out = await readContextFiles(repo());
    expect(out.files).toEqual([]);
  });

  it("returns null for a path that isn't a directory", async () => {
    const dir = repo();
    const file = path.join(dir, "CLAUDE.md");
    writeFileSync(file, "x\n");
    expect(await readContextFiles(file)).toBeNull();
    expect(await readContextFiles(path.join(dir, "nope"))).toBeNull();
  });

  it("refuses a whitelisted name that symlinks outside the project", async () => {
    const outside = repo();
    const secret = path.join(outside, "id_rsa");
    writeFileSync(secret, "PRIVATE KEY\n");
    const dir = repo();
    // The one way a fixed whitelist could still read arbitrary files: put the
    // approved NAME in the repo but point it somewhere else.
    symlinkSync(secret, path.join(dir, "CLAUDE.md"));

    const out = await readContextFiles(dir);
    expect(out.files).toEqual([]);
  });

  it("refuses a symlink into a SIBLING directory that shares the project's name prefix", async () => {
    // The containment check is a string prefix compare, so "/x/repo-secrets"
    // must not read as inside "/x/repo". Appending the separator before
    // comparing is what makes that hold.
    const parent = repo();
    const project = path.join(parent, "repo");
    const sibling = path.join(parent, "repo-secrets");
    mkdirSync(project);
    mkdirSync(sibling);
    const secret = path.join(sibling, "CLAUDE.md");
    writeFileSync(secret, "SIBLING SECRET\n");
    symlinkSync(secret, path.join(project, "CLAUDE.md"));

    expect((await readContextFiles(project)).files).toEqual([]);
  });

  it("follows a symlink that stays inside the project", async () => {
    const dir = repo();
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "instructions.md"), "shared\n");
    symlinkSync(path.join(dir, "docs", "instructions.md"), path.join(dir, "AGENTS.md"));

    const out = await readContextFiles(dir);
    expect(out.files.map((f) => f.path)).toEqual(["AGENTS.md"]);
    expect(out.files[0].content).toBe("shared\n");
  });

  it("truncates a file past the per-file cap and flags it", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "CLAUDE.md"), "x".repeat(300 * 1024));

    const [file] = (await readContextFiles(dir)).files;
    expect(file.truncated).toBe(true);
    expect(file.content.length).toBe(256 * 1024);
    // `size` stays the file's real size — the app tells the user what it cut.
    expect(file.size).toBe(300 * 1024);
  });
});

describe("writeContextFile", () => {
  /** The mtime of a file as the read path reports it — what a client would have
   *  in hand when it goes to save. */
  async function mtimeOf(dir, rel) {
    const out = await readContextFiles(dir);
    return out.files.find((f) => f.path === rel)?.mtime ?? null;
  }

  it("creates a whitelisted file that doesn't exist yet", async () => {
    const dir = repo();
    const out = await writeContextFile(dir, "CLAUDE.md", "# Hello\n", null);

    expect(out.ok).toBe(true);
    expect(out.file.path).toBe("CLAUDE.md");
    expect(out.file.size).toBe(8);
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe("# Hello\n");
  });

  it("creates the parent directory for the nested form", async () => {
    const dir = repo();
    const out = await writeContextFile(dir, ".claude/CLAUDE.md", "nested\n", null);

    expect(out.ok).toBe(true);
    // Forward-slashed on the way out even where the host uses a different sep.
    expect(out.file.path).toBe(".claude/CLAUDE.md");
    expect(readFileSync(path.join(dir, ".claude", "CLAUDE.md"), "utf8")).toBe("nested\n");
  });

  it("overwrites when the mtime matches what the caller read", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "AGENTS.md"), "old\n");
    const mtime = await mtimeOf(dir, "AGENTS.md");

    const out = await writeContextFile(dir, "AGENTS.md", "new\n", mtime);
    expect(out.ok).toBe(true);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("new\n");
    // The returned file is what's on disk now, so a client can keep editing
    // and chain its next save off it. (Its mtime may EQUAL the one we sent —
    // stamps are millisecond-resolution and a small write lands inside one.)
    expect(out.file.content).toBe("new\n");
    expect(out.file.mtime).toBe(await mtimeOf(dir, "AGENTS.md"));
  });

  it("refuses a save whose mtime is stale — an agent edited it meanwhile", async () => {
    const dir = repo();
    const file = path.join(dir, "CLAUDE.md");
    writeFileSync(file, "original\n");
    const stale = "2000-01-01T00:00:00.000Z";

    const out = await writeContextFile(dir, "CLAUDE.md", "mine\n", stale);
    expect(out).toMatchObject({ ok: false, error: "conflict" });
    // The loser's content must still be on disk — a refused save changes nothing.
    expect(readFileSync(file, "utf8")).toBe("original\n");
    // …and the caller is told what the host actually has, so it can reload.
    expect(out.file).toBe(await mtimeOf(dir, "CLAUDE.md"));
  });

  it("treats an existing file as a conflict when the caller expected a new one", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "CLAUDE.md"), "already here\n");

    const out = await writeContextFile(dir, "CLAUDE.md", "mine\n", null);
    expect(out).toMatchObject({ ok: false, error: "conflict" });
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe("already here\n");
  });

  it("forces the write when no mtime is supplied at all", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "CLAUDE.md"), "original\n");

    const out = await writeContextFile(dir, "CLAUDE.md", "forced\n");
    expect(out.ok).toBe(true);
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe("forced\n");
  });

  it("refuses anything outside the whitelist, including traversal", async () => {
    const dir = repo();
    for (const rel of [
      "README.md",
      ".env",
      "../CLAUDE.md",
      "docs/../../CLAUDE.md",
      path.join(dir, "CLAUDE.md"), // absolute
      "",
    ]) {
      const out = await writeContextFile(dir, rel, "pwned\n");
      expect(out).toMatchObject({ ok: false, error: "not a context file" });
    }
    expect(existsSync(path.join(dir, "README.md"))).toBe(false);
  });

  it("refuses to write through a symlink that points out of the project", async () => {
    const outside = repo();
    const secret = path.join(outside, "id_rsa");
    writeFileSync(secret, "PRIVATE KEY\n");
    const dir = repo();
    symlinkSync(secret, path.join(dir, "CLAUDE.md"));

    const out = await writeContextFile(dir, "CLAUDE.md", "pwned\n");
    expect(out).toMatchObject({ ok: false, error: "outside project" });
    expect(readFileSync(secret, "utf8")).toBe("PRIVATE KEY\n");
  });

  it("refuses content past the per-file cap rather than truncating it", async () => {
    const dir = repo();
    const out = await writeContextFile(dir, "CLAUDE.md", "x".repeat(300 * 1024), null);
    expect(out).toMatchObject({ ok: false, error: "too large" });
    expect(existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("leaves no temp file behind after a successful save", async () => {
    const dir = repo();
    await writeContextFile(dir, "CLAUDE.md", "clean\n", null);
    // An atomic tmp+rename that forgot to rename would show up here, and a
    // stray `CLAUDE.md.pounce-*.tmp` in a repo is somebody's next git status.
    expect(readdirSync(dir)).toEqual(["CLAUDE.md"]);
  });

  it("returns not-found for a directory that isn't there", async () => {
    const out = await writeContextFile(path.join(repo(), "nope"), "CLAUDE.md", "x\n");
    expect(out).toMatchObject({ ok: false, error: "not found" });
  });
});
