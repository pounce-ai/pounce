import { describe, expect, it } from "vitest";
import type { Device, Session } from "@pounce/shared";
import { availAgentsForDevices, branchesInScope, sortAgents } from "./agentScope";

const dev = (id: string, agents: string[]): Device => ({ id, agents }) as unknown as Device;
const sess = (branch: string | null, worktree: string | null): Session =>
  ({ branch, worktree }) as unknown as Session;

describe("sortAgents", () => {
  it("orders by canonical rank", () => {
    expect(sortAgents(["opencode", "cursor", "claude", "codex"])).toEqual([
      "claude",
      "codex",
      "cursor",
      "opencode",
    ]);
  });
  it("puts unknown agents last, alphabetically", () => {
    expect(sortAgents(["zeta", "claude", "alpha"])).toEqual(["claude", "alpha", "zeta"]);
  });
  it("dedupes", () => {
    expect(sortAgents(["cursor", "cursor", "claude"])).toEqual(["claude", "cursor"]);
  });
});

describe("availAgentsForDevices", () => {
  const devices = [dev("d1", ["claude", "opencode"]), dev("d2", ["claude", "cursor"])];
  it("unions available agents across all devices", () => {
    expect(availAgentsForDevices(devices, null).sort()).toEqual(["claude", "cursor", "opencode"]);
  });
  it("narrows to a single device when filtered", () => {
    expect(availAgentsForDevices(devices, "d2").sort()).toEqual(["claude", "cursor"]);
  });
  it("tolerates a device with no agents field", () => {
    expect(availAgentsForDevices([{ id: "d3" } as unknown as Device], null)).toEqual([]);
  });
});

describe("branchesInScope", () => {
  it("collects distinct branches + worktrees, sorted, skipping null", () => {
    const scope = [
      sess("main", null),
      sess("feat", "wt-a"),
      sess(null, null),
      sess("main", "wt-b"),
    ];
    expect(branchesInScope(scope)).toEqual(["feat", "main", "wt-a", "wt-b"]);
  });
  it("is empty when nothing has a branch or worktree", () => {
    expect(branchesInScope([sess(null, null)])).toEqual([]);
  });
});
