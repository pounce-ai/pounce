/**
 * Web root — the DESKTOP shell, not the mobile router. Web clones how desktop
 * works by running desktop's actual Shell (sidebar, tab strip, docks) under
 * react-native-web; the shared screens reach it through the same router shim
 * desktop uses. Startup mirrors desktop/App.tsx with the page origin standing
 * in for 127.0.0.1: when the bridge itself serves this bundle, its /ui is
 * same-origin and self-pairing works exactly like the macOS app.
 */
import { useEffect } from "react";
import { useUnistyles } from "react-native-unistyles";
import { Providers } from "@pounce/app/components/Providers";
import { MarkdownImageLightbox } from "@pounce/app/components/MarkdownImageLightbox";
import { Shell } from "../../desktop/src/shell/Shell";
import { applyAppearance } from "@pounce/app/state/appearance";
import { bootstrap } from "@pounce/app/services/runtime";
import { pairFromParams } from "@pounce/app/services/pairing";
import { ensureLocalBridge } from "../../desktop/src/services/localBridge";
import { startHeartbeatCadence } from "../../desktop/src/services/heartbeat";

/** One-shot pairing from a `?url=…&code=…` connect link, then scrub the query
 *  so the credential doesn't linger in the address bar or history. `token=` is
 *  the older shape and still works; nothing emits it by default. */
async function pairFromUrl(): Promise<void> {
  const q = new URLSearchParams(window.location.search);
  const url = q.get("url");
  const token = q.get("token");
  const code = q.get("code");
  if (!url || !(token || code)) return;
  await pairFromParams({
    url,
    token,
    code,
    node: q.get("node"),
    relay: q.get("relay"),
    host: q.get("host"),
  });
  window.history.replaceState(null, "", window.location.pathname);
}

export default function WebApp() {
  // Subscribes the root to theme changes so a palette switch repaints the
  // whole tree without remounting it (same reasoning as desktop/App.tsx).
  useUnistyles();

  useEffect(() => {
    applyAppearance();
    const origin = window.location.origin;
    void (async () => {
      await pairFromUrl();
      await ensureLocalBridge(origin);
      await bootstrap();
    })();
    return startHeartbeatCadence(origin);
  }, []);

  return (
    <Providers>
      <Shell />
      <MarkdownImageLightbox />
    </Providers>
  );
}
