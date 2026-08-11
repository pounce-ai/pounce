/**
 * Which fenced blocks earn a "Run" button.
 *
 * The rule these pin: an affordance must not be a guess. Offering Run on a line
 * of JavaScript is discovered by tapping it, which is the worst way to find out.
 */
import { describe, expect, it } from "vitest";
import { isDestructive, splitCodeBlocks } from "./runnableBlocks";

const blocks = (text: string) =>
  splitCodeBlocks(text).filter((s): s is Extract<typeof s, { type: "code" }> => s.type === "code");

const one = (text: string) => blocks(text)[0];

describe("untagged blocks", () => {
  it("does NOT offer to run a line of code that merely looks word-shaped", () => {
    // The regression: one line, starts with a letter — the old test passed it.
    const seg = one('```\nsending || activity === "running" || activity === "streaming"\n```');
    expect(seg.runnable).toBe(false);
  });

  it.each([
    ["const x = foo(1)", "an assignment with a call"],
    ["doThing()", "a bare call"],
    ["items.map((i) => i.id)", "an arrow function"],
    ["if (a === b) return", "a conditional"],
    ["user.name", "a property access"],
  ])("leaves %s alone (%s)", (code) => {
    expect(one("```\n" + code + "\n```").runnable).toBe(false);
  });

  it.each([
    "npm install",
    "npx use-pounce",
    "git status",
    "cd ~/Projects/pounce && ls",
    "bun run test",
    "docker compose up -d",
    "/usr/bin/python3 script.py",
  ])("offers to run %s", (code) => {
    expect(one("```\n" + code + "\n```").runnable).toBe(true);
  });

  it("won't run an unrecognised program — a guess is worse than nothing", () => {
    expect(one("```\nfrobnicate --all\n```").runnable).toBe(false);
  });

  it("won't run multiple lines it wasn't told are shell", () => {
    expect(one("```\nnpm install\nnpm test\n```").runnable).toBe(false);
  });
});

describe("tagged blocks", () => {
  it.each(["bash", "sh", "shell", "zsh", "console"])("trusts a ```%s tag", (lang) => {
    const seg = one("```" + lang + "\nfrobnicate --all\nsecond line\n```");
    expect(seg.runnable).toBe(true);
  });

  it("never runs a non-shell language, however command-like the body", () => {
    expect(one("```ts\nnpm install\n```").runnable).toBe(false);
  });

  it("strips prompts and Claude Code's bang prefix from what gets run", () => {
    expect(one("```bash\n$ npm install\n```").code).toBe("npm install");
    expect(one("```bash\n!git status\n```").code).toBe("git status");
  });

  it("keeps a non-shell block's body verbatim", () => {
    expect(one("```ts\nconst a = 1;\n```").code).toBe("const a = 1;");
  });
});

describe("splitting", () => {
  it("returns one md segment when there are no fences", () => {
    expect(splitCodeBlocks("just prose")).toEqual([{ type: "md", text: "just prose" }]);
  });

  it("keeps prose around a block", () => {
    const segs = splitCodeBlocks("before\n\n```bash\nls\n```\n\nafter");
    expect(segs.map((s) => s.type)).toEqual(["md", "code", "md"]);
  });
});

/**
 * Which commands need a press-and-hold. The bar is "hard to take back", not
 * "dangerous in theory" — a false positive costs a long press, a false negative
 * costs a directory.
 */
describe("destructive commands", () => {
  it.each([
    "rm -rf ./build",
    "rm file.txt",
    "sudo rm -rf /",
    "git reset --hard HEAD~3",
    "git clean -fd",
    "git push origin main --force",
    "git branch -D feature",
    "kill -9 1234",
    "pkill -f node",
    "docker system prune -a",
    "npm unpublish my-pkg",
    "shutdown -h now",
    "dd if=/dev/zero of=/dev/disk2",
    "echo hi > /etc/hosts",
  ])("asks for a hold: %s", (cmd) => {
    expect(isDestructive(cmd)).toBe(true);
  });

  it.each([
    "npm install",
    "npm run build",
    "git status",
    "git commit -m 'fix: remove dead code'",
    "ls -la",
    "cat package.json",
    "bun test",
    "docker ps",
    "curl https://example.com",
    "grep -r 'rm' src",
  ])("runs on a tap: %s", (cmd) => {
    expect(isDestructive(cmd)).toBe(false);
  });

  it("isn't fooled by a destructive word inside a safe command", () => {
    // "rm" appears, but as a search term and a commit message — not as a verb.
    expect(isDestructive("grep -r 'rm -rf' .")).toBe(false);
    expect(isDestructive('git commit -m "rm old files"')).toBe(false);
  });
});
