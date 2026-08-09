// Webview frontend: poll the bridge's localhost UI surface and render status.
// The bridge port is passed in the URL (?port=) by the bun main process.
const params = new URLSearchParams(location.search);
const port = params.get("port") || "8099";
const base = `http://127.0.0.1:${port}`;

const el = (id: string) => document.getElementById(id) as HTMLElement;
const qr = el("qr") as HTMLImageElement;

// QR is static for a given session; load it once (cache-busted).
qr.src = `${base}/qr.svg?t=${Date.now()}`;

type Ui = {
  pairUrl?: string;
  daemonOk?: boolean;
  devices?: number;
  connected?: boolean;
};

async function tick() {
  try {
    const r = await fetch(`${base}/ui`, { cache: "no-store" });
    const d: Ui = await r.json();
    el("addr").textContent = d.pairUrl ?? "—";

    const dot = el("dot");
    const text = el("statusText");
    const hint = el("hint");

    if (d.connected) {
      const n = d.devices && d.devices > 0 ? d.devices : 1;
      dot.className = "dot ok";
      text.textContent = `Connected · ${n} device${n === 1 ? "" : "s"}`;
      hint.textContent = "Your phone is talking to this computer. You're all set.";
    } else if (!d.daemonOk) {
      dot.className = "dot warn";
      text.textContent = "Starting your agent host…";
      hint.textContent = "Waiting for the Pounce agent host to come online.";
    } else {
      dot.className = "dot idle";
      text.textContent = "Ready to pair";
      hint.textContent = "Open Pounce on your phone → Sync → Scan this code.";
    }
  } catch {
    el("statusText").textContent = "Starting…";
  }
}

void tick();
setInterval(() => void tick(), 3000);
