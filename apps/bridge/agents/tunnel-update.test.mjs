/**
 * The update sequence, and specifically the ways it is allowed to fail.
 *
 * On a remote server this runs over the tunnel it is replacing, so nobody is
 * watching and there may be no second way in. What matters is not that the
 * happy path works — it's that every unhappy path ends with the machine still
 * reachable, and says honestly which one happened.
 */
import { describe, expect, it, vi } from "vitest";
import { runTunnelUpdate } from "./tunnel-update.mjs";

/** A machine that behaves however the test says, recording what was done to it. */
function machine({ installs = "0.2.0", comesUp = true, canRollback = true } = {}) {
  const calls = [];
  let version = "0.1.0";
  let comesUpNow = comesUp;
  return {
    calls,
    io: {
      currentVersion: () => version,
      install: async () => {
        if (installs instanceof Error) throw installs;
        calls.push("install");
        version = installs;
        return { version: installs, tag: `tunnel-v${installs}` };
      },
      restart: async () => void calls.push("restart"),
      isUp: async () => {
        calls.push("isUp");
        return comesUpNow;
      },
      rollback: () => {
        calls.push("rollback");
        if (!canRollback) return false;
        version = "0.1.0";
        comesUpNow = true; // the binary that was working a minute ago
        return true;
      },
    },
  };
}

describe("a good update", () => {
  it("installs, restarts, confirms — in that order", async () => {
    const m = machine();
    const r = await runTunnelUpdate(m.io);
    expect(r).toMatchObject({ state: "ok", from: "0.1.0", to: "0.2.0", swapped: true });
    expect(m.calls).toEqual(["install", "restart", "isUp"]);
  });
});

describe("a new binary that won't start", () => {
  it("puts the old one back and says so", async () => {
    const m = machine({ comesUp: false });
    const r = await runTunnelUpdate(m.io);
    expect(r.state).toBe("rolled-back");
    expect(r.error).toMatch(/did not start; restored 0\.1\.0/);
    // Rolled back AND restarted again — restoring the file is not enough, the
    // process has to be back on it or the machine is still unreachable.
    expect(m.calls).toEqual(["install", "restart", "isUp", "rollback", "restart", "isUp"]);
  });

  it("reports failure, not a rollback, when the old one can't be restored", async () => {
    // The genuinely bad outcome. It must not be dressed up as recovery — this
    // is the state where somebody has to go and find an SSH client.
    const m = machine({ comesUp: false, canRollback: false });
    const r = await runTunnelUpdate(m.io);
    expect(r.state).toBe("failed");
    expect(r.error).toMatch(/could not be restored/);
  });

  it("does not claim recovery when the restored binary also fails to come up", async () => {
    const m = machine({ comesUp: false });
    // Rollback reports success, but the machine still won't stand up.
    m.io.rollback = () => true;
    const r = await runTunnelUpdate(m.io);
    expect(r.state).toBe("failed");
  });
});

describe("an update that never got started", () => {
  it("leaves the tunnel alone when the download fails", async () => {
    const m = machine({ installs: new Error("digest mismatch") });
    const r = await runTunnelUpdate(m.io);
    expect(r).toMatchObject({ state: "failed", swapped: false, to: null });
    expect(r.error).toMatch(/digest mismatch/);
    // Nothing was restarted, so a machine that was reachable still is. A failed
    // update must never be worse than no update.
    expect(m.calls).toEqual([]);
  });
});

describe("what it reports back", () => {
  it("always carries the version it came from, so a partial result is readable", async () => {
    const m = machine({ installs: new Error("offline") });
    expect((await runTunnelUpdate(m.io)).from).toBe("0.1.0");
  });

  it("logs the outcome for whoever reads the server's own log", async () => {
    const log = vi.fn();
    await runTunnelUpdate({ ...machine().io, log });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/updated 0\.1\.0 -> 0\.2\.0/));
  });
});
