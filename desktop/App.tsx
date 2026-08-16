import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { useUnistyles } from "react-native-unistyles";
import { Providers } from "@pounce/app/components/Providers";
import { Shell } from "./src/shell/Shell";
import { applyAppearance } from "@pounce/app/state/appearance";
import { bootstrap } from "@pounce/app/services/runtime";
import { ensureLocalBridge } from "./src/services/localBridge";
import { startHeartbeatCadence } from "./src/services/heartbeat";
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
    // bootstrap connects whatever devices are configured, then keep everything
    // fresh on the shared cadence (see heartbeat.ts).
    void ensureLocalBridge().finally(() => void bootstrap());
    return startHeartbeatCadence();
  }, []);

  return (
    <Providers>
      <StatusBar style="light" />
      <Shell />
      <UpdateConsent />
    </Providers>
  );
}
