import { describe, expect, it } from "vitest";
import { mergeHosts, parseKnownHosts, parseSshConfig } from "./ssh-hosts.mjs";

describe("parseSshConfig", () => {
  it("reads an alias with its settings", () => {
    const { entries } = parseSshConfig(`
      Host gpu-box
        HostName 10.0.0.4
        User deploy
        Port 2222
    `);
    expect(entries).toEqual([
      { name: "gpu-box", source: "config", hostName: "10.0.0.4", user: "deploy", port: 2222 },
    ]);
  });

  it("gives every alias on one Host line its own entry", () => {
    const { entries } = parseSshConfig("Host web1 web2\n  User deploy");
    expect(entries.map((e) => e.name)).toEqual(["web1", "web2"]);
    expect(entries.every((e) => e.user === "deploy")).toBe(true);
  });

  it("skips patterns — `Host *` is defaults, not a machine", () => {
    const { entries } = parseSshConfig("Host *\n  User me\nHost real\n  User you");
    expect(entries.map((e) => e.name)).toEqual(["real"]);
  });

  it("accepts `=` separators, which are legal and rare", () => {
    const { entries } = parseSshConfig("Host=box\n  HostName=1.2.3.4\n  Port=2200");
    expect(entries[0]).toMatchObject({ name: "box", hostName: "1.2.3.4", port: 2200 });
  });

  it("is case-insensitive about keywords", () => {
    const { entries } = parseSshConfig("HOST box\n  hostname 1.2.3.4\n  USER root");
    expect(entries[0]).toMatchObject({ hostName: "1.2.3.4", user: "root" });
  });

  it("ignores comments and blank lines", () => {
    const { entries } = parseSshConfig("# a note\n\nHost box\n  # another\n  User me");
    expect(entries).toHaveLength(1);
    expect(entries[0].user).toBe("me");
  });

  it("stops attributing settings after a Match block", () => {
    // Match is conditional on things we can't evaluate, so what follows is not
    // reliably a property of the Host above it.
    const { entries } = parseSshConfig("Host box\n  User me\nMatch host other\n  User wrong");
    expect(entries[0].user).toBe("me");
  });

  it("collects Include directives", () => {
    const { includes } = parseSshConfig("Include ~/.ssh/config.d/*\nHost box");
    expect(includes).toEqual(["~/.ssh/config.d/*"]);
  });
});

describe("parseKnownHosts", () => {
  it("keeps the name and drops the address it resolved to", () => {
    // ssh records both on one line; a list of IPs beside the name is noise.
    expect(parseKnownHosts("gpu-box,10.0.0.4 ssh-ed25519 AAAAC3Nz")).toEqual(["gpu-box"]);
  });

  it("keeps the address when that is all the line has", () => {
    expect(parseKnownHosts("10.0.0.4 ssh-ed25519 AAAAC3Nz")).toEqual(["10.0.0.4"]);
    expect(parseKnownHosts("fe80::1 ssh-ed25519 AAAAC3Nz")).toEqual(["fe80::1"]);
  });

  it("splits several names on one line", () => {
    expect(parseKnownHosts("web1,web1.internal ssh-rsa AAAA")).toEqual(["web1", "web1.internal"]);
  });

  it("skips hashed entries rather than showing gibberish", () => {
    // HashKnownHosts is one-way — the name cannot be recovered.
    expect(parseKnownHosts("|1|abc=|def= ssh-rsa AAAA")).toEqual([]);
  });

  it("unwraps the [host]:port form", () => {
    expect(parseKnownHosts("[example.com]:2222 ssh-rsa AAAA")).toEqual(["example.com"]);
  });

  it("handles @cert-authority and @revoked markers", () => {
    expect(parseKnownHosts("@cert-authority *.example.com ssh-rsa AAAA")).toEqual([]);
    expect(parseKnownHosts("@revoked bad.example ssh-rsa AAAA")).toEqual(["bad.example"]);
  });

  it("skips wildcard patterns", () => {
    expect(parseKnownHosts("*.internal ssh-rsa AAAA")).toEqual([]);
  });
});

describe("mergeHosts", () => {
  const alias = { name: "gpu-box", source: "config", hostName: "10.0.0.4", user: null, port: null };

  it("puts named aliases first", () => {
    const out = mergeHosts([alias], ["aaa.example"]);
    expect(out.map((h) => h.name)).toEqual(["gpu-box", "aaa.example"]);
  });

  it("does not list an alias twice because known_hosts also has it", () => {
    const out = mergeHosts([alias], ["gpu-box"]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("config");
  });

  it("sorts the known_hosts pile, which has no meaningful order", () => {
    const out = mergeHosts([], ["zeta", "alpha", "mid"]);
    expect(out.map((h) => h.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("drops duplicate aliases from overlapping Includes", () => {
    expect(mergeHosts([alias, { ...alias }], [])).toHaveLength(1);
  });
});
