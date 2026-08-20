/**
 * What a version badge is allowed to claim.
 *
 * The interesting cases are all the ones where the honest answer is "I don't
 * know". A badge that fails to appear costs somebody an update they would have
 * got anyway; a badge that appears wrongly sends them to reinstall a CLI that
 * was already current, and the next one they see they will not believe.
 */
import { describe, expect, it } from "vitest";
import { isBehind, normalizeVersion } from "./agent-versions.mjs";

describe("finding the version in --version output", () => {
  it("reads each agent's actual shape", () => {
    // These are real outputs, not invented ones — none of the four agree.
    expect(normalizeVersion("2.1.237 (Claude Code)")).toBe("2.1.237");
    expect(normalizeVersion("codex-cli 0.146.0")).toBe("0.146.0");
    expect(normalizeVersion("1.18.18")).toBe("1.18.18");
    expect(normalizeVersion("2026.07.16-899851b")).toBe("2026.07.16-899851b");
  });

  it("keeps the build suffix, which is the only thing separating two Cursor builds", () => {
    expect(normalizeVersion("2026.08.11-e8db854")).toBe("2026.08.11-e8db854");
  });

  it("has no answer rather than a wrong one", () => {
    expect(normalizeVersion(null)).toBeNull();
    expect(normalizeVersion("")).toBeNull();
    expect(normalizeVersion("command not found")).toBeNull();
  });
});

describe("deciding whether a machine is behind", () => {
  it("ranks semver both ways", () => {
    expect(isBehind("0.146.0", "0.148.0")).toBe(true);
    expect(isBehind("1.18.19", "1.18.18")).toBe(false);
    expect(isBehind("2.1.237", "2.1.237")).toBe(false);
  });

  it("ranks CalVer by its date", () => {
    expect(isBehind("2026.07.16-899851b", "2026.08.11-e8db854", { calver: true })).toBe(true);
    expect(isBehind("2026.08.11-e8db854", "2026.07.16-899851b", { calver: true })).toBe(false);
  });

  /**
   * The case this whole `boolean | null` shape exists for. Two builds from the
   * same day differ only by a git sha, and a sha has NO order — comparing them
   * lexically produces a confident answer that means nothing. `null` is the
   * truth, and the UI renders it as silence.
   */
  it("refuses to rank two builds from the same day", () => {
    expect(isBehind("2026.08.11-aaaaaaa", "2026.08.11-bbbbbbb", { calver: true })).toBeNull();
    expect(isBehind("2026.08.11-bbbbbbb", "2026.08.11-aaaaaaa", { calver: true })).toBeNull();
  });

  it("says nothing when either side is missing", () => {
    // No network, or a CLI that wouldn't answer --version. Not "up to date".
    expect(isBehind("2.1.237", null)).toBeNull();
    expect(isBehind(null, "2.1.237")).toBeNull();
    expect(isBehind(null, null)).toBeNull();
  });

  it("does not mistake a CalVer version for semver", () => {
    // Without the calver flag this is compared as numbers and 2026.07.16 vs
    // 2026.08.11 happens to rank correctly — but the same-day case would not.
    // Pinned so a future "simplification" that drops the flag has to fail here.
    expect(isBehind("2026.08.11-aaaaaaa", "2026.08.11-bbbbbbb", { calver: true })).toBeNull();
  });
});
