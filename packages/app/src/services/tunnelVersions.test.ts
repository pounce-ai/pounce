/**
 * What counts as "in sync".
 *
 * The whole feature is a claim about a set of machines, so the cases that
 * matter are the ones where a machine can't vote. A laptop with its lid shut
 * must not read as drift (the warning would never go out), and a fleet nobody
 * has heard from must not read as agreement (that's the silence this replaces).
 */
import { describe, expect, it } from "vitest";
import { fleetDrift, type TunnelStatus, versionText } from "./tunnelVersions";

const machine = (over: Partial<TunnelStatus> = {}): TunnelStatus => ({
  hostId: "h",
  name: "machine",
  reachable: true,
  installed: true,
  running: true,
  version: "0.2.0",
  proto: "pounce/tunnel/1",
  source: "binary",
  latest: null,
  updateAvailable: null,
  lastUpdate: null,
  error: null,
  ...over,
});

describe("is the fleet in sync", () => {
  it("agrees when every machine reports the same version", () => {
    const d = fleetDrift([machine(), machine({ hostId: "b" })]);
    expect(d).toMatchObject({ inSync: true, versions: ["0.2.0"], unknown: 0 });
  });

  it("reports drift, and names the versions in play", () => {
    const d = fleetDrift([machine(), machine({ hostId: "b", version: "0.1.0" })]);
    expect(d.inSync).toBe(false);
    expect(d.versions).toEqual(["0.1.0", "0.2.0"]);
  });

  it("does not call an unreachable machine drift", () => {
    // The failure that would make this unusable: one sleeping laptop lighting
    // the warning permanently for everybody.
    const d = fleetDrift([machine(), machine({ hostId: "b", reachable: false, version: null })]);
    expect(d.inSync).toBe(true);
    expect(d.unknown).toBe(1);
  });

  it("does not call an unreachable fleet agreement either", () => {
    // The opposite failure, and the worse one: "all in sync" for machines
    // nobody has actually heard from.
    const d = fleetDrift([
      machine({ reachable: false, version: null }),
      machine({ hostId: "b", reachable: false, version: null }),
    ]);
    expect(d.unknown).toBe(2);
    expect(d.versions).toEqual([]);
  });

  it("counts a machine with no tunnel as unknown, not as a version", () => {
    const d = fleetDrift([machine(), machine({ hostId: "b", installed: false, version: null })]);
    expect(d).toMatchObject({ inSync: true, unknown: 1 });
  });

  it("counts what could actually be moved forward", () => {
    const d = fleetDrift([
      machine({ updateAvailable: true }),
      machine({ hostId: "b", updateAvailable: false }),
      machine({ hostId: "c", reachable: false, updateAvailable: null }),
    ]);
    expect(d.updatable).toBe(1);
  });

  it("is in sync when there is nothing to compare", () => {
    expect(fleetDrift([])).toMatchObject({ inSync: true, versions: [], unknown: 0 });
  });
});

describe("what a row says", () => {
  it("separates 'couldn't ask' from 'has no tunnel' from 'has one, unidentified'", () => {
    // Three genuinely different situations, three different fixes. Rendering
    // any of them as a version number sends the reader down the wrong path.
    expect(versionText(machine({ reachable: false }))).toBe("Can't reach");
    expect(versionText(machine({ installed: false }))).toBe("No tunnel — LAN only");
    expect(versionText(machine({ version: null, source: "unknown" }))).toBe("Unknown version");
  });

  it("marks a version we recorded rather than one the binary vouched for", () => {
    expect(versionText(machine({ source: "stamp" }))).toBe("0.2.0 (recorded)");
    expect(versionText(machine({ source: "binary" }))).toBe("0.2.0");
  });
});
