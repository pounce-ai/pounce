/**
 * "Which other Pounce machines are on this network?"
 *
 * Every bridge shouts a tiny beacon onto a multicast group and listens for
 * everyone else's, so the desktop app can offer "MacBook Air is nearby — ask it
 * for access" instead of making the user carry a token across machines by hand.
 *
 * WHY A HAND-ROLLED BEACON AND NOT BONJOUR. The bridge ships as a single
 * `bun --compile` executable (bridge-main.mjs) with no Node on the host, so a
 * dependency with any native component is out, and even a pure-JS mDNS stack is
 * a bundling risk taken for no gain: the only thing that needs to find a Pounce
 * bridge is another Pounce bridge. `node:dgram` is built in, bundles cleanly,
 * and the whole protocol is two message types.
 *
 * WHAT IS ON THE WIRE. Nothing secret, ever — a beacon is broadcast to the
 * entire LAN and anyone can read it:
 *
 *   { v: 1, t: "hello"|"query", bridgeId, hostName, platform, port, version }
 *
 * No token, no repo names, no thread titles. Discovery only establishes that a
 * machine exists and where to reach it; everything past that point goes through
 * the approve-and-scope handshake in access.mjs.
 *
 * `bridgeId` is the same stable machine id from identity.mjs that the apps
 * already canonicalize devices on (see adoptBridgeId), so a peer discovered
 * here and a device paired by QR collapse onto one row rather than showing up
 * twice.
 *
 * A `query` is answered with a UNICAST hello straight back to the asker. That
 * makes a freshly launched app's list populate in milliseconds instead of
 * waiting out someone else's announce interval — the difference between
 * "Nearby machines" feeling instant and feeling broken.
 */
import dgram from "node:dgram";
import os from "node:os";

/** Administratively-scoped multicast (RFC 2365 239.255/16) — private to a site,
 *  routers won't forward it off the local network. */
const GROUP = "239.255.42.99";
const PORT = 48099;
/** How often we announce. Short enough that a machine waking up shows up in a
 *  few seconds; long enough to be invisible next to any real traffic. */
const ANNOUNCE_MS = 5_000;
/** A peer unheard-from for this long is gone. Three missed announces, so one
 *  dropped multicast packet — routine on Wi-Fi — doesn't flicker the list. */
const TTL_MS = 20_000;
/** Beacons are ~150 bytes; anything larger is not ours. */
const MAX_MSG = 512;

/**
 * @param {object} opts
 * @param {string}  opts.bridgeId  this machine's stable id (identity.mjs)
 * @param {number}  opts.port      the bridge's HTTP port, so peers know where to knock
 * @param {() => (string|null)} [opts.version] app version, read late (it is set after boot)
 */
export function createDiscovery({ bridgeId, port, version = () => null }) {
  /** @type {Map<string, {bridgeId:string, hostName:string, platform:string, port:number, version:string|null, address:string, firstSeenAt:number, lastSeenAt:number}>} */
  const peers = new Map();
  let sock = null;
  let timer = null;
  let stopped = false;

  const self = () => ({
    v: 1,
    bridgeId,
    hostName: os.hostname().replace(/\.local$/, ""),
    platform: process.platform,
    port,
    version: version(),
  });

  /** Multicast has to be joined per-interface: a Mac with Wi-Fi and Ethernet
   *  otherwise listens on exactly one of them, chosen by the routing table, and
   *  which one is not predictable. Failures are per-interface and ignored —
   *  a VPN or virtual adapter that refuses the join must not take the rest down. */
  const joinAll = () => {
    let joined = 0;
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== "IPv4" || a.internal) continue;
        try {
          sock.addMembership(GROUP, a.address);
          joined++;
        } catch {
          // Already joined, or an interface that can't do multicast.
          void name;
        }
      }
    }
    if (!joined) {
      try {
        sock.addMembership(GROUP); // default interface — better than nothing
      } catch {}
    }
  };

  const send = (obj, to) => {
    if (!sock) return;
    const buf = Buffer.from(JSON.stringify(obj));
    try {
      if (to) sock.send(buf, to.port, to.address);
      else sock.send(buf, PORT, GROUP);
    } catch {
      // Offline, or the group went away with the interface. The next tick retries.
    }
  };

  const onMessage = (buf, rinfo) => {
    if (buf.length > MAX_MSG) return;
    let msg;
    try {
      msg = JSON.parse(buf.toString("utf8"));
    } catch {
      return; // not ours — the group is shared with whatever else picked it
    }
    if (msg?.v !== 1 || typeof msg.bridgeId !== "string" || !msg.bridgeId) return;
    if (msg.bridgeId === bridgeId) return; // our own shout, looped back

    if (msg.t === "query") {
      // Answer privately rather than to the group: only the asker is waiting,
      // and N bridges replying to the group is N² packets for no reason.
      send({ ...self(), t: "hello" }, rinfo);
      return;
    }
    if (msg.t !== "hello") return;

    const now = Date.now();
    const prev = peers.get(msg.bridgeId);
    peers.set(msg.bridgeId, {
      bridgeId: msg.bridgeId,
      hostName: typeof msg.hostName === "string" ? msg.hostName.slice(0, 64) : rinfo.address,
      platform: typeof msg.platform === "string" ? msg.platform.slice(0, 16) : "unknown",
      // The port is claimed by the peer, but the ADDRESS is the datagram's real
      // source — a peer cannot talk us into probing some third machine.
      port: Number(msg.port) || 8099,
      version: typeof msg.version === "string" ? msg.version.slice(0, 32) : null,
      address: rinfo.address,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
  };

  return {
    start() {
      if (sock || stopped) return;
      try {
        sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      } catch {
        sock = null;
        return;
      }
      sock.on("error", () => {
        // Bind conflict or an interface disappearing mid-flight. Discovery is a
        // convenience; it must never be able to take the bridge down.
        try {
          sock?.close();
        } catch {}
        sock = null;
        if (timer) clearInterval(timer);
        timer = null;
      });
      sock.on("message", onMessage);
      sock.bind(PORT, () => {
        try {
          // Loopback stays ON. Switching it off is the obvious tidy-up — we
          // never want to see our own beacon — but it suppresses the datagram
          // for the whole host, not just this socket, so two bridges on one
          // machine become invisible to each other. That is not a hypothetical:
          // it is how this gets tested, and how a second user account on a
          // shared Mac behaves. Our own beacon is dropped by bridgeId instead,
          // which costs one discarded packet every five seconds.
          sock.setMulticastLoopback(true);
          sock.setMulticastTTL(1); // this link only — never routed off the LAN
        } catch {}
        joinAll();
        send({ ...self(), t: "hello" });
        send({ ...self(), t: "query" }); // pull everyone else's identity now
      });
      timer = setInterval(() => {
        // Re-join every tick: interfaces come and go (Wi-Fi reconnect, VPN up,
        // dock plugged in) and a membership does not survive its interface.
        joinAll();
        send({ ...self(), t: "hello" });
      }, ANNOUNCE_MS);
      timer.unref?.();
    },

    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      try {
        sock?.close();
      } catch {}
      sock = null;
      peers.clear();
    },

    /** Peers heard from within the TTL, most recently seen first. Prunes as it
     *  goes so a machine that went to sleep drops off the list on its own. */
    list() {
      const cutoff = Date.now() - TTL_MS;
      const out = [];
      for (const [id, p] of peers) {
        if (p.lastSeenAt < cutoff) peers.delete(id);
        else out.push({ ...p, url: `http://${p.address}:${p.port}` });
      }
      return out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    },

    /** Ask everyone to identify themselves now — the app calls this when the
     *  user opens "Nearby machines" so the list is warm immediately. */
    refresh() {
      send({ ...self(), t: "query" });
    },

    get running() {
      return !!sock;
    },
  };
}
