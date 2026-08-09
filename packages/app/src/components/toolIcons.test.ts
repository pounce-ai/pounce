/**
 * Every name below was taken from a real transcript on this machine (claude and
 * opencode) or from the adapter that emits it (codex, cursor) — not invented.
 * A wrong icon is worse than no icon, so the table is the spec.
 */
import { describe, expect, it } from "vitest";
import { isShellTool, normalizeToolName, toolIcon } from "./toolIcons";

describe("normalizeToolName", () => {
  it("unwraps an MCP server prefix", () => {
    expect(normalizeToolName("mcp__claude-in-chrome__navigate")).toBe("navigate");
  });

  it("splits camelCase so it matches the same patterns as snake_case", () => {
    expect(normalizeToolName("WebFetch")).toBe("web_fetch");
    expect(normalizeToolName("read_file")).toBe("read_file");
  });
});

describe("isShellTool", () => {
  it.each(["shell", "bash", "exec_command", "run_terminal_cmd"])("treats %s as shell", (name) => {
    expect(isShellTool(name)).toBe(true);
  });

  // The word-boundary matching exists for exactly these: both contain a shell
  // word as a substring but are not commands.
  it.each(["todowrite", "cachebro_cache_clear", "codebase_search"])(
    "does not treat %s as shell",
    (name) => {
      expect(isShellTool(name)).toBe(false);
    },
  );
});

describe("toolIcon", () => {
  it.each([
    // claude
    ["Edit", "pencil-outline"],
    ["Read", "document-text-outline"],
    ["Write", "create-outline"],
    ["TaskUpdate", "list-outline"],
    ["WebFetch", "globe-outline"],
    ["WebSearch", "globe-outline"],
    ["AskUserQuestion", "help-circle-outline"],
    ["ToolSearch", "search"],
    ["EnterPlanMode", "list-outline"],
    ["MultiEdit", "pencil-outline"],
    ["mcp__claude-in-chrome__computer", "desktop-outline"],
    ["mcp__claude-in-chrome__navigate", "globe-outline"],
    // opencode
    ["write", "create-outline"],
    ["read", "document-text-outline"],
    ["glob", "folder-outline"],
    ["webfetch", "globe-outline"],
    ["todowrite", "list-outline"],
    ["cachebro_read_file", "document-text-outline"],
    // codex
    ["apply_patch", "pencil-outline"],
    ["web_search", "globe-outline"],
    // cursor
    ["read_file", "document-text-outline"],
    ["edit_file", "pencil-outline"],
    ["list_dir", "folder-outline"],
    ["grep", "search"],
    ["codebase_search", "search"],
  ])("maps %s to %s", (name, icon) => {
    expect(toolIcon(name)).toBe(icon);
  });

  it("falls back to a wrench for an unknown tool", () => {
    expect(toolIcon("cachebro_cache_clear")).toBe("construct-outline");
    expect(toolIcon("some_vendor_thing")).toBe("construct-outline");
  });

  it("never returns an icon the SF Symbol map can't name", async () => {
    // A name outside the Ionicons vocabulary renders as a blank box on desktop,
    // which is worse than the wrench fallback — keep the table honest.
    const { SF_SYMBOL } = await import("../ui/native/icon-map");
    const used = [
      "list-outline",
      "globe-outline",
      "help-circle-outline",
      "search",
      "folder-outline",
      "pencil-outline",
      "create-outline",
      "document-text-outline",
      "git-branch-outline",
      "desktop-outline",
      "construct-outline",
    ] as const;
    for (const name of used) expect(SF_SYMBOL[name]).toBeTruthy();
  });
});
