/**
 * Adding a machine over SSH, from the app's side.
 *
 * The bridge on this machine does the actual work (apps/bridge/agents/ssh.mjs):
 * it drives the SSH session, runs `npx use-pounce` on the far end, and reads
 * that machine's pairing details back over the same connection. This is the
 * client for it, plus the last step the bridge can't do — writing the device
 * into the app's own store.
 *
 * All of it is loopback-only, like the peer controls next door: spawning an SSH
 * client as this user, with this user's keys, is the owner's business alone.
 *
 * Worth being clear about what SSH is and isn't here. It gets the remote bridge
 * running and tells us its iroh identity; after that it's over. The stored
 * device dials the tunnel exactly as a scanned QR would — which is why a
 * machine added on the desktop also shows up on the phone, where there is no
 * SSH at all.
 */
import { addDeviceConfig, type DeviceConfig } from "./bridge";
import { machineName } from "./sshHosts";
import { local, localToken, mine, minePost } from "./ownBridge";
import { streamTurn } from "./streamTurn";

/** Where the bootstrap has got to.
 *
 *  `starting` and `pairing` are reported by the remote script itself rather
 *  than guessed from its output, so they stay true if the CLI's wording
 *  changes. */
export type SshPhase = "connecting" | "starting" | "pairing" | "prompt" | "done" | "failed";

/** Something SSH stopped to ask. We relay it rather than answering: a host-key
 *  fingerprint is the person's decision, and we hold no passwords. */
export interface SshPrompt {
  readonly kind: "host-key" | "passphrase" | "password" | "verification";
  /** Don't echo it. True for anything but the host-key question, which the
   *  person needs to be able to read before agreeing to it. */
  readonly secret: boolean;
  readonly text: string;
}

/** What we learned about the machine — ready for `addDeviceConfig`. */
export interface SshDevice {
  readonly url: string;
  readonly token: string;
  readonly nodeId: string;
  readonly relay: string | null;
  readonly hostName: string;
}

export interface SshState {
  readonly id: string;
  readonly host: string;
  readonly phase: SshPhase;
  readonly prompt: SshPrompt | null;
  readonly error: string | null;
  readonly device: SshDevice | null;
}

/** A stream frame: the state, plus whatever the session just printed. */
export interface SshFrame extends SshState {
  readonly output?: string;
  readonly first?: boolean;
}

/**
 * A machine this computer already knows how to reach.
 *
 * `config` hosts are ones you deliberately named and usually come with the
 * username and port already settled, so picking one can fill the whole form.
 * `known_hosts` is everything you've ever connected to — a memory aid, and
 * nothing more than a name.
 */
export interface SshHost {
  readonly name: string;
  readonly source: "config" | "known_hosts";
  readonly hostName: string | null;
  readonly user: string | null;
  readonly port: number | null;
}

/** Read fresh from disk on every call, so Refresh means what it says. */
export function listSshHosts(): Promise<{ hosts: SshHost[] }> {
  return mine<{ hosts: SshHost[] }>("/v1/ssh/hosts");
}

export interface SshTarget {
  /** Passed to `ssh` untouched, so an ~/.ssh/config alias keeps its meaning. */
  readonly host: string;
  readonly user?: string | null;
  readonly sshPort?: number | null;
  /** Which port the bridge should use on the far side. Only worth changing on a
   *  machine already running something on 8099. */
  readonly bridgePort?: number | null;
}

/** Begin. Resolves as soon as the SSH child is spawned — everything after that
 *  arrives on the stream. */
export function startSsh(target: SshTarget): Promise<SshState> {
  return minePost<SshState>("/v1/ssh/start", {
    host: target.host.trim(),
    user: target.user?.trim() || null,
    sshPort: target.sshPort || null,
    bridgePort: target.bridgePort || null,
  });
}

export function sshStatus(id: string): Promise<SshState> {
  return mine<SshState>(`/v1/ssh/status?id=${encodeURIComponent(id)}`);
}

/** Answer whatever SSH asked. The newline is ours to add — the caller passes
 *  the answer, not the keystrokes. */
export function answerSsh(id: string, answer: string): Promise<{ ok: boolean }> {
  return minePost<{ ok: boolean }>("/v1/ssh/input", { id, data: `${answer}\n` });
}

export function cancelSsh(id: string): Promise<{ ok: boolean }> {
  return minePost<{ ok: boolean }>("/v1/ssh/cancel", { id });
}

/**
 * Watch a run. Calls `onFrame` for every change; returns a stop function.
 *
 * Deliberately no reconnect loop, unlike the terminal dock: a bootstrap is a
 * few minutes with somebody watching it, and silently reattaching to a session
 * whose prompt has already timed out would show a stale screen. If the stream
 * drops, the screen falls back to polling `sshStatus`.
 */
export function streamSsh(id: string, onFrame: (frame: SshFrame) => void): () => void {
  let stopped = false;
  void (async () => {
    const token = await localToken();
    if (stopped) return;
    let buf = "";
    try {
      await streamTurn(
        `${local()}/v1/ssh/stream?id=${encodeURIComponent(id)}`,
        { method: "GET", headers: { authorization: `Bearer ${token ?? ""}` } },
        (chunk) => {
          if (stopped) return true;
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue; // keepalive comment
            try {
              onFrame(JSON.parse(line.slice(5).trim()) as SshFrame);
            } catch {
              /* can't be partial — we split on the terminator */
            }
          }
          return false;
        },
      );
    } catch {
      /* the screen polls sshStatus if this never delivers */
    }
  })();
  return () => {
    stopped = true;
  };
}

/**
 * Save the machine.
 *
 * The name comes from `machineName`, which weighs the target you dialled
 * against the one the far side reports; `namePinned` is what stops the next
 * sync overwriting that with whatever the bridge calls itself. `sshHost` keeps
 * the target, which is how the suggestion list knows this machine is already
 * added.
 */
export function saveSshDevice(device: SshDevice, sshHost?: string): Promise<DeviceConfig> {
  return addDeviceConfig(device.url, device.token, {
    nodeId: device.nodeId,
    relay: device.relay,
    name: machineName(sshHost, device.hostName),
    namePinned: true,
    sshHost: sshHost?.trim() || undefined,
    // Remembered, not guessed. Without it a server added this way is
    // indistinguishable in Settings from a Mac on the same Wi-Fi — same icon,
    // same bare "Offline" — when in fact it is only ever reachable through its
    // tunnel, which is exactly what you need to know when it stops answering.
    addedVia: "ssh",
  });
}
