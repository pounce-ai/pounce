/**
 * What `pounce update` decides to do — the half worth pinning, because getting
 * it wrong either leaves a machine stale or restarts a bridge that isn't ours.
 *
 * The command exists because `npx use-pounce` updating itself updates nothing
 * on the machine: `configure --bridge` pins a login service to a copy under
 * ~/.pounce/app, and that copy is whatever version the day it was installed.
 */
import { describe, expect, it } from "vitest";
import { compareSemver, planUpdate } from "./update.mjs";

const step = (steps, id) => steps.find((s) => s.id === id);

describe("compareSemver", () => {
  it("orders versions numerically, not as strings", () => {
    expect(compareSemver("0.9.0", "0.10.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });

  it("treats a prerelease as its release, so it is never told it is behind itself", () => {
    expect(compareSemver("0.7.0-rc.1", "0.7.0")).toBe(0);
  });
});

describe("planUpdate", () => {
  const base = { cli: "0.6.0", latest: "0.7.0" };

  it("updates the permanent copy the login service actually runs", () => {
    const steps = planUpdate({ ...base, installed: "0.4.0", hasService: true });
    expect(step(steps, "copy")).toMatchObject({ from: "0.4.0", to: "0.7.0", act: true });
    // ...and restarts the service, because a replaced file changes nothing
    // until whatever is running it is restarted.
    expect(step(steps, "service")?.act).toBe(true);
  });

  it("leaves a current copy alone, and doesn't restart anything for it", () => {
    const steps = planUpdate({ ...base, installed: "0.7.0", hasService: true });
    expect(step(steps, "copy").act).toBe(false);
    expect(step(steps, "service")).toBeUndefined();
  });

  it("reports a service whose copy has been pruned away instead of guessing", () => {
    const steps = planUpdate({ ...base, installed: null, hasService: true });
    expect(step(steps, "copy")).toMatchObject({ from: null, act: false });
    expect(step(steps, "copy").note).toContain("configure");
  });

  it("says nothing about a machine with nothing installed on it", () => {
    expect(planUpdate({ cli: "0.7.0", latest: "0.7.0" })).toEqual([]);
  });

  it("restarts a stale bridge only when it is one we started", () => {
    const stale = { running: true, version: "0.4.0" };
    expect(step(planUpdate({ ...base, bridge: { ...stale, ours: true } }), "bridge")?.act).toBe(
      true,
    );
    // The desktop app's bridge, or a login service's — not ours to kill.
    expect(step(planUpdate({ ...base, bridge: { ...stale, ours: false } }), "bridge")).toBe(
      undefined,
    );
  });

  it("doesn't restart a bridge that is already running this code", () => {
    const steps = planUpdate({
      ...base,
      bridge: { running: true, ours: true, version: "0.6.0" },
    });
    expect(step(steps, "bridge")).toBeUndefined();
  });

  it("takes the bridge's word for whether the tunnel is behind", () => {
    const yes = planUpdate({
      ...base,
      tunnel: { installed: true, version: "0.1.0", latest: "0.2.0", updateAvailable: true },
    });
    expect(step(yes, "tunnel")).toMatchObject({ from: "0.1.0", to: "0.2.0", act: true });

    const no = planUpdate({
      ...base,
      tunnel: { installed: true, version: "0.2.0", latest: "0.2.0", updateAvailable: false },
    });
    expect(step(no, "tunnel").act).toBe(false);

    // No binary at all is `pounce`'s job to install, not this command's.
    expect(step(planUpdate({ ...base, tunnel: { installed: false } }), "tunnel")).toBeUndefined();
  });

  it("mentions a newer CLI but never claims it can install one", () => {
    // An npx run cannot replace itself mid-flight, so this stays advisory.
    const s = step(planUpdate({ cli: "0.6.0", latest: "0.7.0", installed: "0.7.0" }), "cli");
    expect(s).toMatchObject({ act: false });
    expect(s.note).toContain("npx use-pounce@latest");
  });

  it("says nothing about the CLI when it is the newest there is", () => {
    expect(step(planUpdate({ cli: "0.7.0", latest: "0.7.0", installed: "0.7.0" }), "cli")).toBe(
      undefined,
    );
  });

  it("stays quiet about versions it couldn't look up rather than crying wolf", () => {
    // The registry was unreachable: nothing is known to be behind, so nothing is.
    const steps = planUpdate({ cli: "0.6.0", latest: null, installed: "0.4.0", hasService: true });
    expect(steps.every((s) => !s.act)).toBe(true);
  });
});
