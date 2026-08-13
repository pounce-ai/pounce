/**
 * Telling a remote server apart from a Mac on the same Wi-Fi.
 *
 * The bug being fixed: a machine bootstrapped over SSH looked exactly like a
 * LAN-paired one — same generic icon, same bare "Offline" — even though its
 * only route in is a tunnel, so "Offline" means something else entirely and
 * calls for a different fix.
 */
import { describe, expect, it } from "vitest";
import { addedViaFor, deviceIconFor, deviceStatusText } from "./deviceProvenance";

describe("recognising an SSH-added machine", () => {
  it("keeps a provenance that was recorded at add time", () => {
    expect(addedViaFor({ addedVia: "ssh" })).toBe("ssh");
  });

  it("infers it for machines added before we recorded it", () => {
    // The backfill that spares anyone re-adding a server: only the SSH
    // bootstrap puts a nodeId on a config without also stamping a grant.
    expect(addedViaFor({ nodeId: "abc123" })).toBe("ssh");
  });

  it("does not mistake a granted peer for one of ours", () => {
    // A peer we were granted access to also carries a nodeId. It is somebody
    // else's machine, reached a different way, and must not be relabelled.
    expect(addedViaFor({ nodeId: "abc123", grant: { id: "g1" } })).toBeUndefined();
  });

  it("leaves a QR- or LAN-paired machine alone", () => {
    // A QR pairing keeps its node id in the global pairing, never on the row —
    // so a config with no nodeId is exactly the ordinary case.
    expect(addedViaFor({})).toBeUndefined();
  });
});

describe("the icon", () => {
  it("lets what we know beat what the name suggests", () => {
    // The reported bug: "Pneucons Prod" matches none of the name patterns, so
    // a real remote server was drawn as a desktop Mac.
    expect(deviceIconFor("Pneucons Prod")).toBe("desktop-outline");
    expect(deviceIconFor("Pneucons Prod", "ssh")).toBe("server-outline");
  });

  it("still guesses sensibly when nothing is on record", () => {
    expect(deviceIconFor("Shubhams-MacBook-Air")).toBe("laptop-outline");
    expect(deviceIconFor("iPhone 15")).toBe("phone-portrait-outline");
    expect(deviceIconFor("ubuntu-box")).toBe("server-outline");
    expect(deviceIconFor("Dirghas-Mac-mini")).toBe("desktop-outline");
  });
});

describe("what the status line says", () => {
  it("says plainly that a remote machine is remote", () => {
    expect(deviceStatusText({ online: false, addedVia: "ssh" })).toBe("Offline · remote, over SSH");
    expect(deviceStatusText({ online: true, addedVia: "ssh" })).toBe("Online · remote");
  });

  it("leaves an ordinary machine's wording untouched", () => {
    expect(deviceStatusText({ online: true })).toBe("Online");
    expect(deviceStatusText({ online: false })).toBe("Offline");
  });
});
