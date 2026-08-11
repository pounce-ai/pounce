import { describe, expect, it } from "vitest";
import {
  detectPrompt,
  namedFailure,
  parseHostName,
  parsePayload,
  remoteScript,
  sshArgs,
  toDevice,
} from "./ssh-script.mjs";

/** What the remote actually sends back: npm noise, our markers, the payload. */
function transcript({ ui, hostName = "gpu-box", noise = true } = {}) {
  return [
    noise ? "The authenticity of host 'gpu-box' can't be established." : "",
    "@@POUNCE:starting@@",
    noise ? "npm warn exec The following package was not found and will be installed" : "",
    "  Pounce is running.",
    "@@POUNCE:pairing@@",
    `@@POUNCE_HOST@@${hostName}@@END@@`,
    `@@POUNCE_UI@@${JSON.stringify(ui)}@@END@@`,
    "@@POUNCE:done@@",
  ].join("\n");
}

const GOOD_UI = {
  ip: "10.0.0.4",
  port: 8099,
  pairUrl: "http://10.0.0.4:8099",
  token: "tok-abc",
  tunnel: { nodeId: "node-xyz", relay: "https://relay.example" },
};

describe("remoteScript", () => {
  it("runs `qr`, never the default command", () => {
    const script = remoteScript();
    // Bare `pounce` ends in waitForPhone(), which polls forever — over SSH that
    // hangs the channel instead of finishing.
    expect(script).toMatch(/use-pounce qr\b/);
    expect(script).not.toMatch(/use-pounce\s*\n/);
  });

  it("reads /ui on the bridge port it was given", () => {
    expect(remoteScript({ bridgePort: 9100 })).toContain("http://127.0.0.1:9100/ui");
  });

  it("falls back to node when the server has no curl", () => {
    const script = remoteScript();
    expect(script).toContain("command -v curl");
    expect(script).toContain("node -e");
  });
});

describe("sshArgs", () => {
  it("forces a TTY so ssh can prompt", () => {
    expect(sshArgs({ host: "gpu-box" })).toContain("-tt");
  });

  it("passes the host through untouched so ssh_config aliases still work", () => {
    const args = sshArgs({ host: "gpu-box" });
    expect(args).toContain("gpu-box");
    expect(args).not.toContain("-l");
  });

  it("adds user and port only when given", () => {
    const args = sshArgs({ host: "h", user: "deploy", sshPort: 2222 });
    expect(args).toContain("-l");
    expect(args[args.indexOf("-l") + 1]).toBe("deploy");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });

  it("keeps strict host checking unless asked otherwise", () => {
    expect(sshArgs({ host: "h" }).join(" ")).not.toContain("StrictHostKeyChecking");
    expect(sshArgs({ host: "h", strictHostKey: false }).join(" ")).toContain("accept-new");
  });

  it("base64s the script so quotes and newlines survive two shells", () => {
    const remote = sshArgs({ host: "h" }).at(-1);
    expect(remote).toMatch(/^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
    const b64 = remote.split(" ")[1];
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(remoteScript());
  });
});

describe("parsing the transcript", () => {
  it("finds the payload among npm's output", () => {
    expect(parsePayload(transcript({ ui: GOOD_UI }))).toEqual(GOOD_UI);
  });

  it("returns null when there is no payload block", () => {
    expect(parsePayload("ssh: connect to host h port 22: Connection refused")).toBeNull();
  });

  it("returns null on a truncated payload rather than throwing", () => {
    expect(parsePayload('@@POUNCE_UI@@{"token":@@END@@')).toBeNull();
  });

  it("reads the hostname, ignoring the unknown fallback", () => {
    expect(parseHostName(transcript({ ui: GOOD_UI }))).toBe("gpu-box");
    expect(parseHostName(transcript({ ui: GOOD_UI, hostName: "unknown" }))).toBeNull();
    expect(parseHostName(transcript({ ui: GOOD_UI, hostName: "mac.local" }))).toBe("mac");
  });
});

describe("toDevice", () => {
  it("keeps the tunnel identity — that is what the phone will dial", () => {
    const { device } = toDevice(GOOD_UI, { hostName: "gpu-box", host: "gpu-box" });
    expect(device).toEqual({
      url: "http://10.0.0.4:8099",
      token: "tok-abc",
      nodeId: "node-xyz",
      relay: "https://relay.example",
      hostName: "gpu-box",
    });
  });

  it("refuses a LAN-only payload", () => {
    // A remote machine's pairUrl is an address on ITS network. Without a node
    // id the device would be unreachable from here and from the phone, so this
    // has to fail at the moment of adding rather than land dead in the list.
    const { device, error } = toDevice({ ...GOOD_UI, tunnel: null }, { host: "gpu-box" });
    expect(device).toBeUndefined();
    expect(error).toMatch(/tunnel didn't/i);
  });

  it("refuses a payload with no token", () => {
    const { error } = toDevice({ ...GOOD_UI, token: null }, { host: "h" });
    expect(error).toMatch(/no token/i);
  });

  it("passes a curl error through", () => {
    expect(
      toDevice({ error: "could not read http://127.0.0.1:8099/ui" }, { host: "h" }).error,
    ).toBe("could not read http://127.0.0.1:8099/ui");
  });

  it("falls back to the ssh host when the server won't name itself", () => {
    const { device } = toDevice(GOOD_UI, { hostName: null, host: "gpu-box.internal" });
    expect(device.hostName).toBe("gpu-box.internal");
  });
});

describe("detectPrompt", () => {
  it("spots a password prompt and marks it secret", () => {
    expect(detectPrompt("deploy@gpu-box's password: ")).toMatchObject({
      kind: "password",
      secret: true,
    });
  });

  it("spots a key passphrase", () => {
    expect(detectPrompt("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ")).toMatchObject({
      kind: "passphrase",
      secret: true,
    });
  });

  it("spots a host-key question and does NOT mark it secret", () => {
    // The fingerprint decision is the person's to make, and they need to read
    // what they're agreeing to — so it echoes.
    const prompt = detectPrompt(
      "ED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
    );
    expect(prompt).toMatchObject({ kind: "host-key", secret: false });
  });

  it("stays quiet on ordinary output", () => {
    expect(detectPrompt("npm warn exec installing use-pounce\n")).toBeNull();
  });
});

describe("namedFailure", () => {
  it("explains a changed host key without jargon", () => {
    const msg = namedFailure("@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@");
    expect(msg).toMatch(/rebuilt|impersonating/i);
  });

  it("explains a missing Node rather than surfacing sh's wording", () => {
    expect(namedFailure("sh: 1: npx: not found")).toMatch(/Node/);
  });

  it("returns null when it has nothing better to say", () => {
    expect(namedFailure("some unexpected output")).toBeNull();
  });
});
