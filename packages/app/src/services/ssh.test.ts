/**
 * Saving a machine added over SSH.
 *
 * The one thing that must survive this hop is the tunnel's own handshake
 * secret. An SSH-added machine's `url` is an address on ITS network, so the
 * tunnel is the only route to it — and since the secret was split from the
 * bearer token, dialling with the bearer token is refused. `saveSshDevice`
 * used to drop `tunnelToken` on the floor, which made every SSH-added machine
 * dial, get refused, fall back to the dead LAN address, and read as "only
 * works when you're on the server's Wi-Fi".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveSshDevice, type SshDevice } from "./ssh";
import { addDeviceConfig } from "./bridge";

vi.mock("./bridge", () => ({
  addDeviceConfig: vi.fn(async (url: string, token: string, extras: object) => ({
    id: "dev:test",
    name: "test",
    url,
    token,
    ...extras,
  })),
}));

const DEVICE: SshDevice = {
  url: "http://10.0.0.5:8099",
  token: "bearer-tok",
  nodeId: "node-abc",
  relay: "https://relay.example",
  tunnelToken: "tunnel-secret",
  hostName: "gpu-box",
};

beforeEach(() => {
  vi.mocked(addDeviceConfig).mockClear();
});

describe("saveSshDevice", () => {
  it("carries the tunnel secret onto the stored row", async () => {
    await saveSshDevice(DEVICE, "gpu-box");
    const extras = vi.mocked(addDeviceConfig).mock.calls[0][2];
    expect(extras).toMatchObject({
      nodeId: "node-abc",
      relay: "https://relay.example",
      tunnelToken: "tunnel-secret",
      addedVia: "ssh",
    });
  });

  it("omits the key entirely when the local bridge predates the secret", async () => {
    // `tunnelToken: undefined` would clobber a secret the row already holds on
    // a re-add; the key must be absent, not present-and-empty.
    const { tunnelToken: _drop, ...pre } = DEVICE;
    await saveSshDevice(pre as SshDevice, "gpu-box");
    const extras = vi.mocked(addDeviceConfig).mock.calls[0][2];
    expect(extras).not.toHaveProperty("tunnelToken");
  });
});
