// Print the Pounce pairing QR on demand. Scan it with the iPhone Camera to
// open Pounce and add this machine. Run: `bun run bridge:qr` from the repo root.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import qrcode from "qrcode-terminal";
import { primaryLanIp } from "./agents/env.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8099);
const TOKEN = process.env.BRIDGE_TOKEN || "pounce-bridge-local";
const ip = primaryLanIp() || "localhost";

const url = `http://${ip}:${PORT}`;
let deepLink = `pounce://connect?url=${encodeURIComponent(url)}&token=${encodeURIComponent(TOKEN)}`;

// Include the tunnel identity when pounce-tunnel has run on this machine — the
// QR then pairs from any network, not just this Wi-Fi. Default port only: the
// machine-wide tunnel identity always targets the default-port bridge.
if (PORT === 8099 || process.env.POUNCE_TUNNEL === "1") {
  try {
    const info = JSON.parse(
      readFileSync(path.join(os.homedir(), ".pounce", "tunnel.json"), "utf8"),
    );
    if (info?.nodeId) {
      deepLink += `&node=${encodeURIComponent(info.nodeId)}&host=${encodeURIComponent(os.hostname().replace(/\.local$/, ""))}`;
      if (info.relay) deepLink += `&relay=${encodeURIComponent(info.relay)}`;
    }
  } catch {}
}

console.log(`\n📲 Pair Pounce — scan with your iPhone Camera:\n`);
qrcode.generate(deepLink, { small: true });
console.log(`\n…or open on the device:\n${deepLink}\n`);
