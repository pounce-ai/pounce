import { useEffect } from "react";
import { AppState } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useUnistyles } from "react-native-unistyles";
import { Providers } from "@pounce/app/components/Providers";
import { Shell } from "./src/shell/Shell";
import { applyAppearance } from "@pounce/app/state/appearance";
import { bootstrap } from "@pounce/app/services/runtime";
import { ensureLocalBridge } from "./src/services/localBridge";
import { heartbeat } from "./src/services/heartbeat";
import { UpdateConsent } from "./src/components/UpdateConsent";

export default function App() {
  // Subscribes the ROOT to theme changes. Desktop style sheets are created at
  // module load and re-resolve on property access (see src/shims/unistyles.ts),
  // so a switch only lands once something re-renders — re-rendering from here
  // repaints the whole tree without remounting it, which would tear down open
  // terminals and tabs.
  useUnistyles();

  useEffect(() => {
    // Hand appearance control to JS: AppDelegate pins the window dark for the
    // pre-mount loading view; PounceAppearance.setStyle releases that pin and
    // applies the persisted System/Light/Dark choice (mobile's root layout
    // does the same on its side). Hydration lands via appearance$.onChange.
    applyAppearance();
    // Adopt the machine-local bridge (zero-config pairing) before the shared
    // bootstrap connects whatever devices are configured.
    void ensureLocalBridge().finally(() => void bootstrap());
    // Aggressive early re-syncs while the embedded bridge + daemon warm up
    // (fresh=1 bypasses the bridge's cache), then a steady refresh cadence.
    const warm = [3_000, 7_000, 12_000, 20_000, 30_000].map((ms) =>
      setTimeout(() => void heartbeat(true).catch(() => {}), ms),
    );
    const steady = setInterval(() => void heartbeat(false).catch(() => {}), 10_000);
    // Timers can stall while the app is inactive — always sync immediately on
    // (re)activation so the window is fresh the moment the user looks at it.
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
      <StatusBar style="light" />
      <Shell />
      <UpdateConsent />
    </Providers>
  );
}
