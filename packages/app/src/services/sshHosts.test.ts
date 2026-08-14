import { describe, expect, it } from "vitest";
import { addedHostKeys, isHostAdded, machineName, parseTarget } from "./sshHosts";

/** The screen asks the question this way: index the devices, then test a row. */
const has = (h: { name: string; hostName?: string | null }, devices: object[]) =>
  isHostAdded(h, addedHostKeys(devices));

describe("isHostAdded", () => {
  it("recognises the target it was added at, whatever the machine calls itself", () => {
    const devices = [
      { name: "pneucons-prod", url: "http://172.31.45.115:8099", sshHost: "pneucons-prod" },
    ];
    expect(has({ name: "pneucons-prod", hostName: "13.202.151.116" }, devices)).toBe(true);
  });

  it("matches the address when that's what was typed", () => {
    const devices = [{ name: "ip-172-31-45-115", sshHost: "ubuntu@13.202.151.116" }];
    expect(has({ name: "13.202.151.116", hostName: null }, devices)).toBe(true);
  });

  it("matches an alias against a device stored before we recorded the target", () => {
    const devices = [{ name: "gpu-box", url: "http://192.168.1.44:8099" }];
    expect(has({ name: "gpu-box", hostName: "192.168.1.44" }, devices)).toBe(true);
  });

  it("ignores case and a trailing dot", () => {
    const devices = [{ sshHost: "Build.Example.Com" }];
    expect(has({ name: "build.example.com.", hostName: null }, devices)).toBe(true);
  });

  it("does not call a host added because this Mac is on loopback", () => {
    const devices = [{ name: "127.0.0.1", url: "http://127.0.0.1:8099" }];
    expect(has({ name: "orb", hostName: "127.0.0.1" }, devices)).toBe(false);
  });

  it("says no for a host nothing in the list matches", () => {
    const devices = [{ name: "ip-172-31-45-115", sshHost: "pneucons-prod" }];
    expect(has({ name: "github.com", hostName: null }, devices)).toBe(false);
    expect(has({ name: "github.com", hostName: null }, [])).toBe(false);
  });
});

describe("parseTarget", () => {
  it("splits a target the way ssh reads it", () => {
    expect(parseTarget("ubuntu@13.202.151.116")).toEqual({
      user: "ubuntu",
      host: "13.202.151.116",
    });
    expect(parseTarget("gpu-box")).toEqual({ user: null, host: "gpu-box" });
  });

  it("takes the LAST @, so a user with one in it still resolves the host", () => {
    expect(parseTarget("me@corp.com@bastion")).toEqual({ user: "me@corp.com", host: "bastion" });
  });

  it("drops a fully-qualified name's trailing dot", () => {
    expect(parseTarget("build.example.com.").host).toBe("build.example.com");
  });
});

describe("machineName", () => {
  it("keeps the name you reached it by over the one the box made up", () => {
    expect(machineName("pneucons-prod", "ip-172-31-45-115")).toBe("pneucons-prod");
    expect(machineName("ubuntu@gpu-box", "ip-10-0-0-4")).toBe("gpu-box");
  });

  it("falls back to the machine's own name when the target was an address", () => {
    expect(machineName("13.202.151.116", "ip-172-31-45-115")).toBe("ip-172-31-45-115");
    expect(machineName("ubuntu@13.202.151.116", "ip-172-31-45-115")).toBe("ip-172-31-45-115");
    expect(machineName("fe80::1", "ip-172-31-45-115")).toBe("ip-172-31-45-115");
    expect(machineName(null, "ip-172-31-45-115")).toBe("ip-172-31-45-115");
  });
});
