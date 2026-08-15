/**
 * Web root — the DESKTOP shell, not the mobile router.
 *
 * Web clones how desktop works by running desktop's actual Shell (sidebar,
 * tab strip, splitter, docks) under react-native-web. The shell is pure RN
 * primitives + unistyles + Legend State — no native modules — and it renders
 * the same shared @pounce/app screens through its router shim, so the screens
 * are reused unchanged. (expo-router's SplitView was considered and rejected:
 * iOS-only alpha, falls back to a bare Slot everywhere else.)
 *
 * Mirrors desktop/App.tsx minus the desktop-only pieces: no UpdateConsent
 * (no Sparkle/Electrobun updater in a browser tab) and localBridge points at
 * the PAGE ORIGIN instead of 127.0.0.1 — when the bridge itself serves this
 * bundle (the Electrobun/Linux deployment, or the dev harness), its
 * loopback-only /ui endpoint is same-origin and pairing is zero-config,
 * exactly like the macOS app.
 */
import { useEffect } from "react";
import { AppState } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { Providers } from "@pounce/app/components/Providers";
import { MarkdownImageLightbox } from "@pounce/app/components/MarkdownImageLightbox";
import { Shell } from "../../desktop/src/shell/Shell";
import { applyAppearance } from "@pounce/app/state/appearance";
import { bootstrap } from "@pounce/app/services/runtime";
import { savePairing } from "@pounce/app/services/runtime";
import { pairingHostName } from "@pounce/app/services/pairing";
import {
  addDeviceConfig,
  adoptBridgeToken,
  connectBridge,
  listDeviceConfigs,
  loadBridgeConfig,
  syncLiveData,
} from "@pounce/app/services/bridge";
import { connection$ } from "@pounce/app/state/stores";

/**
 * One-shot pairing from the URL, replacing the mobile /connect route: a
 * `?url=…&token=…[&node=…&relay=…&host=…]` link pairs this browser with a
 * bridge, then scrubs the query so the token doesn't linger in the address
 * bar or history.
 */
async function pairFromUrl(): Promise<boolean> {
  const q = new URLSearchParams(window.location.search);
  const url = q.get("url");
  const token = q.get("token");
  if (!url || !token) return false;
  const node = q.get("node");
  const host = q.get("host") ?? undefined;
  if (node) {
    await savePairing({
      nodeId: node,
      token,
      hostName: pairingHostName({ url, token, hostName: host }),
      relay: q.get("relay"),
    });
  }
  const ok = await connectBridge({ url, token });
  window.history.replaceState(null, "", window.location.pathname);
  return ok;
}

/**
 * Same-origin bridge adoption — desktop's ensureLocalBridge with the page
 * origin standing in for 127.0.0.1:8099 (see desktop/src/services/localBridge
 * for why the token is re-adopted on every probe rather than only on first
 * add). No-op when the page isn't served by a bridge: /ui 404s or times out
 * and whatever is already configured stands.
 */
async function ensureOriginBridge(): Promise<void> {
  const origin = window.location.origin;
  try {
    const devices = await listDeviceConfigs();
    const configured = devices.some((d) => d.url === origin);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2500);
    let res: Response;
    try {
      res = await fetch(`${origin}/ui`, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return;
    const { token } = (await res.json()) as { token?: string };
    if (!token) return;
    if (configured) await adoptBridgeToken(origin, token);
    else await addDeviceConfig(origin, token);
  } catch {
    // Not bridge-served (or bridge not up) — URL pairing / saved config apply.
  }
}

/** Desktop's heartbeat, minus the localhost adoption it already did above. */
async function heartbeat(fresh: boolean): Promise<void> {
  const bridge = await loadBridgeConfig();
  if (!bridge) return;
  if (connection$.status.get() !== "connected") {
    await connectBridge(bridge);
    return;
  }
  try {
    await syncLiveData({ fresh });
  } catch (e) {
    console.warn(`[heartbeat] sync failed: ${String(e)}`);
  }
}

export default function WebApp() {
  // Subscribes the root to theme changes so a palette switch repaints the
  // whole tree without remounting it (same reasoning as desktop/App.tsx).
  useUnistyles();

  useEffect(() => {
    applyAppearance();
    void (async () => {
      await pairFromUrl();
      await ensureOriginBridge();
      await bootstrap();
    })();
    // Same cadence as desktop: eager re-syncs while things warm up, then a
    // steady refresh, plus an immediate sync when the tab becomes visible.
    const warm = [3_000, 7_000, 12_000, 20_000, 30_000].map((ms) =>
      setTimeout(() => void heartbeat(true).catch(() => {}), ms),
    );
    const steady = setInterval(() => void heartbeat(false).catch(() => {}), 10_000);
    const activation = AppState.addEventListener("change", (state) => {
      if (state === "active") void heartbeat(true).catch(() => {});
    });
    return () => {
      warm.forEach(clearTimeout);
      clearInterval(steady);
      activation.remove();
    };
  }, []);

  return (
    <Providers>
      <Shell />
      <MarkdownImageLightbox />
    </Providers>
  );
}
